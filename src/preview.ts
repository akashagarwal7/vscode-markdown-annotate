/** The annotatable preview: a webview panel rendering one Markdown document. */
import * as vscode from 'vscode';
import { blockDiff } from './core/diff';
import { renderMarkdown } from './core/markdown';
import { palette, previewTheme, scrollSync, setPreviewTheme, setWriteToFile, writeToFile } from './config';
import { BaseResult, GitBase } from './git';
import type { HighlightService } from './highlights';
import type { FromWebview, RenderMessage, ToWebview, WebviewState } from './protocol';

export const VIEW_TYPE = 'markdownAnnotate.preview';

/** Changes on every activation, i.e. after every install or reload. */
const ASSET_VERSION = Date.now().toString(36);

export class PreviewManager implements vscode.WebviewPanelSerializer, vscode.Disposable {
  private readonly previews = new Map<string, Preview>();
  private activePreview?: Preview;
  private readonly activeEmitter = new vscode.EventEmitter<void>();
  private readonly git = new GitBase();
  private readonly disposables: vscode.Disposable[] = [this.activeEmitter, this.git];

  /** Fires when the focused preview changes. */
  readonly onDidChangeActive = this.activeEmitter.event;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly service: HighlightService,
  ) {
    this.disposables.push(
      vscode.window.registerWebviewPanelSerializer(VIEW_TYPE, this),
      vscode.workspace.onDidChangeTextDocument((e) => this.previews.get(e.document.uri.toString())?.scheduleRender()),
      service.store.onDidChange((uri) => this.refresh(uri)),
      // A commit, checkout or stage can move the diff base.
      this.git.onDidChange(() => {
        for (const p of this.previews.values()) {
          p.baseChanged();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('markdownAnnotate')) {
          this.refresh();
        }
      }),
      vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
        if (scrollSync() && e.textEditor === vscode.window.activeTextEditor && e.visibleRanges.length) {
          this.previews.get(e.textEditor.document.uri.toString())?.post({
            type: 'scrollToLine',
            line: e.visibleRanges[0].start.line,
          });
        }
      }),
    );
  }

  dispose(): void {
    for (const p of this.previews.values()) {
      p.panel.dispose();
    }
    this.disposables.forEach((d) => d.dispose());
  }

  get active(): Preview | undefined {
    return this.activePreview;
  }

  get(uri: vscode.Uri): Preview | undefined {
    return this.previews.get(uri.toString());
  }

  async open(uri: vscode.Uri, column: vscode.ViewColumn, preserveFocus = false): Promise<Preview> {
    const existing = this.get(uri);
    if (existing) {
      existing.panel.reveal(column, preserveFocus);
      return existing;
    }
    const panel = vscode.window.createWebviewPanel(
      VIEW_TYPE,
      '',
      { viewColumn: column, preserveFocus },
      this.webviewOptions(uri),
    );
    return this.attach(panel, uri);
  }

  async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: WebviewState | undefined): Promise<void> {
    if (!state?.uri) {
      panel.dispose();
      return;
    }
    const uri = vscode.Uri.parse(state.uri);
    panel.webview.options = this.webviewOptions(uri);
    await this.attach(panel, uri);
  }

  private webviewOptions(uri: vscode.Uri): vscode.WebviewPanelOptions & vscode.WebviewOptions {
    const roots = [vscode.Uri.joinPath(this.extensionUri, 'dist'), vscode.Uri.joinPath(this.extensionUri, 'media')];
    roots.push(vscode.Uri.joinPath(uri, '..'));
    for (const f of vscode.workspace.workspaceFolders ?? []) {
      roots.push(f.uri);
    }
    return { enableScripts: true, enableFindWidget: true, localResourceRoots: roots };
  }

  private async attach(panel: vscode.WebviewPanel, uri: vscode.Uri): Promise<Preview> {
    const preview = new Preview(panel, uri, this.extensionUri, this.service, this.git);
    this.previews.set(uri.toString(), preview);
    panel.onDidDispose(() => {
      this.previews.delete(uri.toString());
      if (this.activePreview === preview) {
        this.setActive(undefined);
      }
    });
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) {
        this.setActive(preview);
      } else if (this.activePreview === preview) {
        this.setActive(undefined);
      }
    });
    if (panel.active) {
      this.setActive(preview);
    }
    await preview.init();
    return preview;
  }

  private setActive(preview: Preview | undefined): void {
    this.activePreview = preview;
    void vscode.commands.executeCommand('setContext', 'markdownAnnotate.previewFocus', !!preview);
    this.activeEmitter.fire();
  }

  private refresh(uri?: vscode.Uri): void {
    for (const p of this.previews.values()) {
      if (!uri || p.uri.toString() === uri.toString()) {
        p.scheduleRender();
      }
    }
  }
}

export class Preview {
  private timer?: ReturnType<typeof setTimeout>;
  private ready = false;
  /** Whether the webview shows the diff against HEAD. */
  private diff = false;
  private base?: Promise<BaseResult>;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly uri: vscode.Uri,
    private readonly extensionUri: vscode.Uri,
    private readonly service: HighlightService,
    private readonly git: GitBase,
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'preview-icon.svg');
    panel.webview.onDidReceiveMessage((m: FromWebview) => void this.handle(m));
  }

  async init(): Promise<void> {
    this.panel.title = `Annotate ${basename(this.uri)}`;
    this.panel.webview.html = this.shell();
  }

  post(message: ToWebview): void {
    if (this.ready) {
      void this.panel.webview.postMessage(message);
    }
  }

  focusHighlight(id: string): void {
    this.panel.reveal(undefined, true);
    this.post({ type: 'focusHighlight', id });
  }

  scheduleRender(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.render(), 150);
  }

  baseChanged(): void {
    this.base = undefined;
    if (this.diff) {
      this.scheduleRender();
    }
  }

  private async document(): Promise<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(this.uri);
  }

  private async render(): Promise<void> {
    if (!this.ready) {
      return;
    }
    let doc: vscode.TextDocument;
    try {
      doc = await this.document();
    } catch {
      this.panel.dispose();
      return;
    }
    const webview = this.panel.webview;
    const env = { resolveImage: (src: string) => this.resolveImage(webview, src) };
    const html = renderMarkdown(this.service.md, doc.getText(), env);
    let diff: RenderMessage['diff'];
    if (this.diff) {
      const base = await (this.base ??= this.git.head(this.uri));
      diff =
        'text' in base
          ? { base: 'HEAD', view: blockDiff(this.service.md, base.text, doc.getText(), env) }
          : { unavailable: base.unavailable };
    }
    this.post({
      type: 'render',
      html,
      title: basename(this.uri),
      highlights: await this.service.store.get(this.uri),
      palette: palette(),
      writeToFile: writeToFile(this.uri),
      theme: previewTheme(),
      diff,
    });
  }

  private resolveImage(webview: vscode.Webview, src: string): string {
    if (/^[a-z][\w+.-]*:/i.test(src) && !src.startsWith('file:')) {
      return src;
    }
    const target = this.resolvePath(src.replace(/[?#].*$/, ''));
    return target ? webview.asWebviewUri(target).toString() : src;
  }

  private resolvePath(path: string): vscode.Uri | undefined {
    if (path.startsWith('file:')) {
      return vscode.Uri.parse(path);
    }
    let decoded = path;
    try {
      decoded = decodeURI(path);
    } catch {
      // Keep as written.
    }
    if (decoded.startsWith('/')) {
      const folder = vscode.workspace.getWorkspaceFolder(this.uri);
      return folder ? vscode.Uri.joinPath(folder.uri, decoded) : vscode.Uri.file(decoded);
    }
    return vscode.Uri.joinPath(this.uri, '..', decoded);
  }

  private async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.diff = !!message.diff;
        await this.render();
        return;
      case 'setDiff':
        this.diff = message.value;
        await this.render();
        return;
      case 'create':
        await this.service.create(await this.document(), message.quote, message.line, message.color);
        return;
      case 'update':
        await this.service.update(await this.document(), message.id, message);
        return;
      case 'delete':
        await this.service.remove(await this.document(), message.id);
        return;
      case 'setWriteToFile':
        await setWriteToFile(message.value);
        return;
      case 'setTheme':
        await setPreviewTheme(message.value);
        return;
      case 'revealLine':
        await this.revealLine(message.line);
        return;
      case 'openLink':
        await this.openLink(message.href);
        return;
    }
  }

  private async revealLine(line: number): Promise<void> {
    const doc = await this.document();
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === this.uri.toString());
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
    });
    const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  private async openLink(href: string): Promise<void> {
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const [path, fragment] = href.split('#');
    const target = this.resolvePath(path);
    if (!target) {
      return;
    }
    const lineMatch = /^L(\d+)/.exec(fragment ?? '');
    const options: vscode.TextDocumentShowOptions = {};
    if (lineMatch) {
      const pos = new vscode.Position(Number(lineMatch[1]) - 1, 0);
      options.selection = new vscode.Range(pos, pos);
    }
    await vscode.commands.executeCommand('vscode.open', target, options);
  }

  private shell(): string {
    const webview = this.panel.webview;
    const nonce = [...Array(32)].map(() => Math.floor(Math.random() * 36).toString(36)).join('');
    // Cache-bust so a reinstall of the same version never serves stale assets.
    const bust = `?v=${ASSET_VERSION}`;
    const script = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'dist', 'webview.js')).toString() + bust;
    const style = webview.asWebviewUri(vscode.Uri.joinPath(this.extensionUri, 'media', 'preview.css')).toString() + bust;
    const state: WebviewState = { uri: this.uri.toString() };
    const csp = [
      "default-src 'none'",
      `img-src ${webview.cspSource} https: data:`,
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `font-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ');
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${style}">
</head>
<body>
<main id="content" class="markdown-body"></main>
<script nonce="${nonce}">window.__ANNOTATE_STATE__ = ${JSON.stringify(state).replace(/</g, '\\u003c')};</script>
<script nonce="${nonce}" src="${script}"></script>
</body>
</html>`;
  }
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.path;
}
