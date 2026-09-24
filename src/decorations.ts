/** Shows highlights in the Markdown source editor too. */
import * as vscode from 'vscode';
import { palette, showInEditor, withAlpha } from './config';
import type { HighlightService } from './highlights';

export class EditorDecorations implements vscode.Disposable {
  private types = new Map<string, vscode.TextEditorDecorationType>();
  private readonly tagType = vscode.window.createTextEditorDecorationType({ opacity: '0.45' });
  private readonly disposables: vscode.Disposable[] = [this.tagType];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(private readonly service: HighlightService) {
    this.createTypes();
    this.disposables.push(
      vscode.window.onDidChangeVisibleTextEditors(() => this.schedule()),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.languageId === 'markdown') {
          this.schedule();
        }
      }),
      service.store.onDidChange(() => this.schedule()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('markdownAnnotate')) {
          this.createTypes();
          this.schedule();
        }
      }),
    );
    this.schedule();
  }

  dispose(): void {
    clearTimeout(this.timer);
    this.types.forEach((t) => t.dispose());
    this.disposables.forEach((d) => d.dispose());
  }

  private createTypes(): void {
    this.types.forEach((t) => t.dispose());
    this.types = new Map(
      palette().map((c) => [
        c.name,
        vscode.window.createTextEditorDecorationType({
          light: { backgroundColor: withAlpha(c.color, 0.55) },
          dark: { backgroundColor: withAlpha(c.color, 0.28) },
          overviewRulerColor: c.color,
          overviewRulerLane: vscode.OverviewRulerLane.Right,
          rangeBehavior: vscode.DecorationRangeBehavior.ClosedClosed,
        }),
      ]),
    );
  }

  private schedule(): void {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.update(), 200);
  }

  private async update(): Promise<void> {
    for (const editor of vscode.window.visibleTextEditors) {
      if (editor.document.languageId !== 'markdown') {
        continue;
      }
      const byColor = new Map<string, vscode.DecorationOptions[]>();
      const tags: vscode.Range[] = [];
      if (showInEditor()) {
        const doc = editor.document;
        for (const h of await this.service.resolve(doc)) {
          const color = this.types.has(h.color) ? h.color : palette()[0].name;
          const list = byColor.get(color) ?? [];
          const hoverMessage = h.note ? new vscode.MarkdownString().appendText(h.note) : undefined;
          for (const r of h.ranges) {
            list.push({ range: new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end)), hoverMessage });
          }
          byColor.set(color, list);
          tags.push(...h.tagRanges.map((r) => new vscode.Range(doc.positionAt(r.start), doc.positionAt(r.end))));
        }
      }
      for (const [name, type] of this.types) {
        editor.setDecorations(type, byColor.get(name) ?? []);
      }
      editor.setDecorations(this.tagType, tags);
    }
  }
}
