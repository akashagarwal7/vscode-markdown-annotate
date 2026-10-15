/** The annotatable preview: a webview panel rendering one Markdown document. */
import * as vscode from 'vscode';
import { blockDiff } from './core/diff';
import { headingLine, renderMarkdown } from './core/markdown';
import { numberHeadings, palette, previewTheme, scrollSync, setNumberHeadings, setPreviewTheme, setWriteToFile, writeToFile } from './config';
import { BaseResult, GitBase } from './git';
import type { HighlightService } from './highlights';
import type { FromWebview, RenderMessage, ToWebview, WebviewState } from './protocol';

export const VIEW_TYPE = 'markdownAnnotate.preview';

/** Previews open at once: one to read in, and one beside it for links and duplicates. */
const MAX_PREVIEWS = 2;

/** Changes on every activation, i.e. after every install or reload. */
const ASSET_VERSION = Date.now().toString(36);

export class PreviewManager implements vscode.WebviewPanelSerializer, vscode.Disposable {
  /** Open previews; a file can have several, each scrolled to its own place. */
  private readonly previews = new Set<Preview>();
  /**
   * Per file, the preview that follows the editor and that sidebar jumps go
   * to: the one last focused or scrolled.
   */
  private readonly leads = new Map<string, Preview>();
  /** Per file, until when editor scrolls are echoes of a preview's own and aren't sent back. */
  private readonly quietUntil = new Map<string, number>();
  private activePreview?: Preview;
  /** Open previews, most recently focused first. */
  private recent: Preview[] = [];
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
      vscode.workspace.onDidChangeTextDocument((e) => this.refresh(e.document.uri)),
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
        const key = e.textEditor.document.uri.toString();
        if (
          e.textEditor === vscode.window.activeTextEditor &&
          e.visibleRanges.length &&
          Date.now() >= (this.quietUntil.get(key) ?? 0)
        ) {
          for (const p of this.previews) {
            if (p.syncsScroll && p.uri.toString() === key) {
              p.post({ type: 'scrollToLine', line: e.visibleRanges[0].start.line });
            }
          }
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

  /** Open previews, most recently focused first. */
  get all(): readonly Preview[] {
    return this.recent;
  }

  /** The file's lead preview, if it has any. */
  get(uri: vscode.Uri): Preview | undefined {
    const key = uri.toString();
    return this.leads.get(key) ?? [...this.previews].find((p) => p.uri.toString() === key);
  }

  /** Show the place `source` is scrolled to in the other preview. */
  duplicate(source: Preview): Promise<Preview> {
    return this.showBeside(source, source.uri, source.topLine);
  }

  /**
   * Show `uri` at `line` in the other preview, keeping the focus in `source`:
   * the one beside it if there is one (switched to `uri` if it shows another
   * file), else a new one.
   */
  async showBeside(source: Preview, uri: vscode.Uri, line?: number): Promise<Preview> {
    const other = this.recent.find((p) => p !== source);
    if (!other) {
      const diff = uri.toString() === source.uri.toString() ? source.showsDiff : undefined;
      // It shows another place, so it doesn't follow the editor until asked to.
      return this.create(uri, vscode.ViewColumn.Beside, true, { line, diff, scrollSync: false });
    }
    if (other.uri.toString() !== uri.toString()) {
      return this.replace(other, uri, true, { line, diff: other.showsDiff, scrollSync: other.syncsScroll });
    }
    other.panel.reveal(undefined, true);
    if (line !== undefined) {
      other.post({ type: 'goToLine', line });
    }
    return other;
  }

  private async create(
    uri: vscode.Uri,
    column: vscode.ViewColumn,
    preserveFocus: boolean,
    start?: Partial<WebviewState>,
  ): Promise<Preview> {
    const panel = vscode.window.createWebviewPanel(VIEW_TYPE, '', { viewColumn: column, preserveFocus }, this.webviewOptions(uri));
    return this.attach(panel, uri, start);
  }

  /** Swap a preview for one of another file, in the same place. */
  private replace(old: Preview, uri: vscode.Uri, preserveFocus: boolean, start?: Partial<WebviewState>): Promise<Preview> {
    const column = old.panel.viewColumn ?? vscode.ViewColumn.Beside;
    old.panel.dispose();
    return this.create(uri, column, preserveFocus, start);
  }

  /** A preview was scrolled by the user: it leads from now on, and the editor follows it. */
  private previewScrolled(preview: Preview, line: number): void {
    const key = preview.uri.toString();
    this.leads.set(key, preview);
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === key);
    if (!preview.syncsScroll || !editor) {
      return;
    }
    const top = new vscode.Position(Math.min(line, editor.document.lineCount - 1), 0);
    this.quietUntil.set(key, Date.now() + 300);
    editor.revealRange(new vscode.Range(top, top), vscode.TextEditorRevealType.AtTop);
  }

  async open(uri: vscode.Uri, column: vscode.ViewColumn, preserveFocus = false): Promise<Preview> {
    const existing = this.get(uri);
    if (existing) {
      existing.panel.reveal(column, preserveFocus);
      return existing;
    }
    // At the limit, the preview least recently looked at shows this file instead.
    const oldest = this.recent.length >= MAX_PREVIEWS ? this.recent[this.recent.length - 1] : undefined;
    return oldest ? this.replace(oldest, uri, preserveFocus) : this.create(uri, column, preserveFocus);
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

  private async attach(panel: vscode.WebviewPanel, uri: vscode.Uri, start?: Partial<WebviewState>): Promise<Preview> {
    const preview: Preview = new Preview(panel, uri, this.extensionUri, this.service, this.git, start, {
      scrolled: (line) => this.previewScrolled(preview, line),
      openBeside: (target, at) => this.showBeside(preview, target, at),
    });
    this.previews.add(preview);
    this.recent.push(preview);
    panel.onDidDispose(() => {
      this.previews.delete(preview);
      this.recent = this.recent.filter((p) => p !== preview);
      if (this.leads.get(uri.toString()) === preview) {
        this.leads.delete(uri.toString());
      }
      if (this.activePreview === preview) {
        this.setActive(undefined);
      }
    });
    panel.onDidChangeViewState(({ webviewPanel }) => {
      if (webviewPanel.active) {
        this.leads.set(uri.toString(), preview);
        this.setActive(preview);
      } else if (this.activePreview === preview) {
        this.setActive(undefined);
      }
    });
    if (panel.active) {
      this.leads.set(uri.toString(), preview);
      this.setActive(preview);
    }
    await preview.init();
    return preview;
  }

  private setActive(preview: Preview | undefined): void {
    this.activePreview = preview;
    if (preview) {
      this.recent = [preview, ...this.recent.filter((p) => p !== preview)];
    }
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
  /** Whether this preview and the editor scroll together. */
  private sync: boolean;

  get syncsScroll(): boolean {
    return this.sync;
  }

  get showsDiff(): boolean {
    return this.diff;
  }
  private base?: Promise<BaseResult>;
  /** The source line at the top of the view, as last reported. */
  topLine?: number;

  constructor(
    readonly panel: vscode.WebviewPanel,
    readonly uri: vscode.Uri,
    private readonly extensionUri: vscode.Uri,
    private readonly service: HighlightService,
    private readonly git: GitBase,
    /** For a duplicate: where to start, and whether to show the diff. */
    private readonly start: Partial<WebviewState> | undefined,
    private readonly host: {
      scrolled(line: number): void;
      /** Open `uri` in a new preview beside this one, at `line`. */
      openBeside(uri: vscode.Uri, line?: number): Promise<unknown>;
    },
  ) {
    this.sync = start?.scrollSync ?? scrollSync();
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

  /** This preview's document, or another one a link preview shows. */
  private async document(uri?: string): Promise<vscode.TextDocument> {
    return vscode.workspace.openTextDocument(uri ? vscode.Uri.parse(uri) : this.uri);
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
      scrollSync: this.sync,
      theme: previewTheme(),
      numberHeadings: numberHeadings(),
      diff,
    });
  }

  /** `src` as the webview can load it; relative to `base`, by default this preview's file. */
  private resolveImage(webview: vscode.Webview, src: string, base = this.uri): string {
    if (/^[a-z][\w+.-]*:/i.test(src) && !src.startsWith('file:')) {
      return src;
    }
    const target = this.resolvePath(src.replace(/[?#].*$/, ''), base);
    return target ? webview.asWebviewUri(target).toString() : src;
  }

  private resolvePath(path: string, base = this.uri): vscode.Uri | undefined {
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
      const folder = vscode.workspace.getWorkspaceFolder(base);
      return folder ? vscode.Uri.joinPath(folder.uri, decoded) : vscode.Uri.file(decoded);
    }
    return vscode.Uri.joinPath(base, '..', decoded);
  }

  private async handle(message: FromWebview): Promise<void> {
    switch (message.type) {
      case 'ready':
        this.ready = true;
        this.diff = !!message.diff;
        this.sync = message.scrollSync ?? scrollSync();
        await this.render();
        return;
      case 'setDiff':
        this.diff = message.value;
        await this.render();
        return;
      case 'create':
        await this.service.create(await this.document(message.uri), message.quote, message.line, message.color);
        this.peekChanged(message.uri);
        return;
      case 'update':
        await this.service.update(await this.document(message.uri), message.id, message);
        this.peekChanged(message.uri);
        return;
      case 'delete':
        await this.service.remove(await this.document(message.uri), message.id);
        this.peekChanged(message.uri);
        return;
      case 'setWriteToFile':
        await setWriteToFile(message.value);
        return;
      case 'setScrollSync':
        this.sync = message.value;
        return;
      case 'scrolled':
        this.topLine = message.line;
        this.host.scrolled(message.line);
        return;
      case 'setTheme':
        await setPreviewTheme(message.value);
        return;
      case 'setNumberHeadings':
        await setNumberHeadings(message.value);
        return;
      case 'revealLine':
        await this.revealLine(message.line, message.uri);
        return;
      case 'link': {
        const reason = await this.service.link(await this.document(message.uri), message.quote, message.line, message.href);
        if (reason) {
          void vscode.window.showWarningMessage(`Markdown Annotate: couldn't add the link (${reason}).`);
        }
        this.peekChanged(message.uri);
        return;
      }
      case 'linkTargets':
        await this.linkTargets(message.uri);
        return;
      case 'openLink':
        await this.openLink(message.href);
        return;
      case 'openLinkToSide':
        await this.openLinkToSide(message.href, message.line);
        return;
      case 'peek':
        await this.peek(message.id, message.href);
        return;
    }
  }

  /** Render the Markdown file a link points to, for the preview card shown while it is hovered. */
  private async peek(id: number, href: string): Promise<void> {
    const target = this.resolvePath(href.split('#')[0]);
    if (!target || !isMarkdown(target)) {
      return;
    }
    const title = basename(target);
    const uri = target.toString();
    let text: string;
    try {
      // An open document may have unsaved changes; anything else is read without opening it.
      const open = vscode.workspace.textDocuments.find((d) => d.uri.toString() === target.toString());
      text = open ? open.getText() : new TextDecoder().decode(await vscode.workspace.fs.readFile(target));
    } catch {
      this.post({ type: 'peek', id, uri, title, error: 'File not found' });
      return;
    }
    const webview = this.panel.webview;
    const html = renderMarkdown(this.service.md, text, { resolveImage: (src) => this.resolveImage(webview, src, target) });
    this.post({ type: 'peek', id, uri, title, html, highlights: await this.service.store.get(target) });
  }

  /** The workspace's files, as relative links from the folder of `uri` (this file by default). */
  private async linkTargets(uri?: string): Promise<void> {
    const base = uri ? vscode.Uri.parse(uri) : this.uri;
    const from = base.path.slice(0, base.path.lastIndexOf('/'));
    const found = await vscode.workspace.findFiles('**/*', undefined, MAX_LINK_TARGETS);
    const files = found
      .filter((f) => f.scheme === base.scheme && !/\/(node_modules|\.git)\//.test(f.path) && f.toString() !== base.toString())
      .map((f) => relativePath(from, f.path))
      .sort();
    this.post({ type: 'linkTargets', base: base.toString(), files });
  }

  /** Changes to this file re-render the preview; another file's are only in the link preview. */
  private peekChanged(uri: string | undefined): void {
    if (uri && uri !== this.uri.toString()) {
      this.post({ type: 'peekChanged', uri });
    }
  }

  private async revealLine(line: number, uri?: string): Promise<void> {
    const doc = await this.document(uri);
    const visible = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === doc.uri.toString());
    const editor = await vscode.window.showTextDocument(doc, {
      viewColumn: visible?.viewColumn ?? vscode.ViewColumn.Beside,
    });
    const pos = new vscode.Position(Math.min(line, doc.lineCount - 1), 0);
    editor.selection = new vscode.Selection(pos, pos);
    editor.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  }

  /**
   * A Markdown target (this file or another) opens in a new preview beside
   * this one, at the heading or line it points to; anything else opens beside.
   */
  private async openLinkToSide(href: string, line?: number): Promise<void> {
    if (href.startsWith('#')) {
      await this.host.openBeside(this.uri, line);
      return;
    }
    if (/^(https?|mailto):/i.test(href)) {
      await vscode.env.openExternal(vscode.Uri.parse(href));
      return;
    }
    const [path, fragment = ''] = href.split('#');
    const target = this.resolvePath(path);
    if (!target) {
      return;
    }
    const lineMatch = /^L(\d+)/.exec(fragment);
    let at = lineMatch ? Number(lineMatch[1]) - 1 : undefined;
    if (!isMarkdown(target)) {
      const selection = at === undefined ? undefined : new vscode.Range(at, 0, at, 0);
      await vscode.commands.executeCommand('vscode.open', target, { viewColumn: vscode.ViewColumn.Beside, selection });
      return;
    }
    if (at === undefined && fragment) {
      try {
        const text = (await vscode.workspace.openTextDocument(target)).getText();
        at = headingLine(this.service.md, text, decodeURIComponent(fragment));
      } catch {
        // A missing file still opens; the preview says what is wrong.
      }
    }
    await this.host.openBeside(target, at);
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
    const state: WebviewState = { ...this.start, uri: this.uri.toString() };
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

/** Files offered when linking, at most. */
const MAX_LINK_TARGETS = 5000;

/** `to` relative to the folder `from`, both absolute paths. */
function relativePath(from: string, to: string): string {
  const a = from.split('/').filter(Boolean);
  const b = to.split('/').filter(Boolean);
  let i = 0;
  while (i < a.length && i < b.length - 1 && a[i] === b[i]) {
    i++;
  }
  return [...Array(a.length - i).fill('..'), ...b.slice(i)].join('/');
}

function isMarkdown(uri: vscode.Uri): boolean {
  return /\.(md|markdown|mdx?|mkd)$/i.test(uri.path);
}

function basename(uri: vscode.Uri): string {
  return uri.path.split('/').pop() ?? uri.path;
}
