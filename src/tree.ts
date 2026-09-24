/** Explorer view listing the highlights of the current Markdown document. */
import * as vscode from 'vscode';
import { colorOf, palette } from './config';
import type { HighlightService, ResolvedHighlight } from './highlights';
import type { PreviewManager } from './preview';

export class HighlightItem extends vscode.TreeItem {
  constructor(
    readonly uri: vscode.Uri,
    readonly highlight: ResolvedHighlight,
    iconDir: vscode.Uri,
  ) {
    super(oneLine(highlight.text) || '(empty)', vscode.TreeItemCollapsibleState.None);
    const h = highlight;
    this.id = `${uri.toString()}#${h.id}`;
    this.description = h.note ? oneLine(h.note) : `line ${h.line + 1}`;
    this.contextValue = h.source === 'file' ? 'highlight.file' : 'highlight.stored';
    this.iconPath = h.orphaned
      ? new vscode.ThemeIcon('warning', new vscode.ThemeColor('list.warningForeground'))
      : vscode.Uri.joinPath(iconDir, `${iconName(h.color)}.svg`);

    const tooltip = new vscode.MarkdownString();
    tooltip.appendMarkdown(`**${capitalise(h.color)}** · line ${h.line + 1} · `);
    tooltip.appendMarkdown(h.source === 'file' ? 'written in the file' : 'stored separately');
    if (h.orphaned) {
      tooltip.appendMarkdown(' · _text no longer found in the document_');
    }
    tooltip.appendMarkdown('\n\n');
    tooltip.appendText(h.text);
    if (h.note) {
      tooltip.appendMarkdown('\n\n---\n\n');
      tooltip.appendText(h.note);
    }
    this.tooltip = tooltip;
    this.command = {
      command: 'markdownAnnotate.revealHighlight',
      title: 'Reveal Highlight',
      arguments: [this],
    };
  }
}

export class HighlightTree implements vscode.TreeDataProvider<HighlightItem>, vscode.Disposable {
  private readonly emitter = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.emitter.event;
  private readonly disposables: vscode.Disposable[] = [this.emitter];
  private document?: vscode.Uri;
  private timer?: ReturnType<typeof setTimeout>;
  readonly view: vscode.TreeView<HighlightItem>;

  constructor(
    private readonly service: HighlightService,
    private readonly previews: PreviewManager,
    private readonly iconDir: vscode.Uri,
  ) {
    this.view = vscode.window.createTreeView('markdownAnnotate.highlights', { treeDataProvider: this });
    this.disposables.push(
      this.view,
      vscode.window.onDidChangeActiveTextEditor(() => this.track()),
      previews.onDidChangeActive(() => this.track()),
      service.store.onDidChange(() => this.refresh()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.toString() === this.document?.toString()) {
          this.refresh();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('markdownAnnotate.colors')) {
          void this.writeIcons().then(() => this.refresh());
        }
      }),
    );
    void this.writeIcons();
    this.track();
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** The document whose highlights are listed. */
  get current(): vscode.Uri | undefined {
    return this.document;
  }

  private track(): void {
    const next = this.previews.active?.uri ?? markdownEditorUri(vscode.window.activeTextEditor);
    if (next && next.toString() !== this.document?.toString()) {
      this.document = next;
      this.view.description = next.path.split('/').pop();
      this.refresh();
    }
  }

  refresh(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => this.emitter.fire(), 200);
  }

  getTreeItem(item: HighlightItem): vscode.TreeItem {
    return item;
  }

  async getChildren(): Promise<HighlightItem[]> {
    if (!this.document) {
      return [];
    }
    let doc: vscode.TextDocument;
    try {
      doc = await vscode.workspace.openTextDocument(this.document);
    } catch {
      return [];
    }
    const highlights = await this.service.resolve(doc);
    return highlights.map((h) => new HighlightItem(doc.uri, h, this.iconDir));
  }

  private async writeIcons(): Promise<void> {
    await vscode.workspace.fs.createDirectory(this.iconDir);
    const names = new Set([...palette().map((c) => c.name)]);
    for (const name of names) {
      const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 16 16"><rect x="2" y="3" width="12" height="10" rx="3" fill="${colorOf(name)}" stroke="rgba(0,0,0,0.25)"/></svg>`;
      await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(this.iconDir, `${iconName(name)}.svg`), Buffer.from(svg));
    }
  }
}

export function markdownEditorUri(editor: vscode.TextEditor | undefined): vscode.Uri | undefined {
  return editor?.document.languageId === 'markdown' ? editor.document.uri : undefined;
}

function iconName(color: string): string {
  // Unknown colours (e.g. from a file written with another palette) use the first swatch.
  return palette().some((c) => c.name === color) ? color : palette()[0].name;
}

function oneLine(text: string): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  return flat.length > 80 ? flat.slice(0, 79) + '…' : flat;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
