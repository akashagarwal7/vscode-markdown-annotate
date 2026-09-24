import * as vscode from 'vscode';
import { palette, previewTheme, setPreviewTheme, setWriteToFile, writeToFile } from './config';
import { EditorDecorations } from './decorations';
import { HighlightService } from './highlights';
import { PreviewManager } from './preview';
import { HighlightStore } from './store';
import { HighlightItem, HighlightTree, markdownEditorUri } from './tree';

export function activate(context: vscode.ExtensionContext): { service: HighlightService; previews: PreviewManager } {
  const store = new HighlightStore(context.workspaceState);
  const service = new HighlightService(store);
  const previews = new PreviewManager(context.extensionUri, service);
  const tree = new HighlightTree(service, previews, vscode.Uri.joinPath(context.globalStorageUri, 'icons'));
  context.subscriptions.push(store, previews, tree, new EditorDecorations(service));

  /** The document a command applies to: explicit arg, focused preview, active editor, or listed in the tree. */
  const target = (arg?: unknown): vscode.Uri | undefined => {
    if (arg instanceof vscode.Uri) {
      return arg;
    }
    return previews.active?.uri ?? markdownEditorUri(vscode.window.activeTextEditor) ?? tree.current;
  };

  const withDocument =
    (run: (doc: vscode.TextDocument) => Promise<unknown>) =>
    async (arg?: unknown): Promise<void> => {
      const uri = target(arg);
      if (!uri) {
        void vscode.window.showInformationMessage('Markdown Annotate: open a Markdown file first.');
        return;
      }
      await run(await vscode.workspace.openTextDocument(uri));
    };

  const register = (id: string, fn: (...args: any[]) => unknown) =>
    context.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register(
    'markdownAnnotate.openPreview',
    withDocument((doc) => previews.open(doc.uri, vscode.window.activeTextEditor?.viewColumn ?? vscode.ViewColumn.Active)),
  );

  register(
    'markdownAnnotate.openPreviewToSide',
    withDocument((doc) => previews.open(doc.uri, vscode.ViewColumn.Beside, true)),
  );

  register(
    'markdownAnnotate.writeHighlightsToFile',
    withDocument(async (doc) => {
      const { written, skipped } = await service.writeAllToFile(doc);
      if (!written && !skipped) {
        void vscode.window.showInformationMessage('Markdown Annotate: there are no stored highlights to write.');
        return;
      }
      const note = skipped ? ` ${skipped} could not be written (e.g. inside code blocks) and remain stored.` : '';
      void vscode.window.showInformationMessage(`Markdown Annotate: wrote ${plural(written, 'highlight')} into the file.${note}`);
    }),
  );

  register(
    'markdownAnnotate.moveHighlightsOutOfFile',
    withDocument(async (doc) => {
      const moved = await service.moveAllOutOfFile(doc);
      void vscode.window.showInformationMessage(
        moved
          ? `Markdown Annotate: moved ${plural(moved, 'highlight')} out of the file; they are now stored separately.`
          : 'Markdown Annotate: the file contains no highlights.',
      );
    }),
  );

  register(
    'markdownAnnotate.clearHighlights',
    withDocument(async (doc) => {
      const count = (await service.resolve(doc)).length;
      if (!count) {
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Remove all ${plural(count, 'highlight')} from ${vscode.workspace.asRelativePath(doc.uri)}?`,
        { modal: true, detail: 'Highlights written into the file are removed from the source (undoable in the editor).' },
        'Remove',
      );
      if (confirm === 'Remove') {
        await service.clear(doc);
      }
    }),
  );

  register(
    'markdownAnnotate.exportHighlights',
    withDocument(async (doc) => {
      const content = await service.exportMarkdown(doc);
      const exported = await vscode.workspace.openTextDocument({ language: 'markdown', content });
      await vscode.window.showTextDocument(exported, vscode.ViewColumn.Beside);
    }),
  );

  register('markdownAnnotate.toggleWriteToFile', async () => {
    const next = !writeToFile(target());
    await setWriteToFile(next);
    void vscode.window.showInformationMessage(
      next
        ? 'Markdown Annotate: new highlights will be written into the Markdown file.'
        : 'Markdown Annotate: new highlights will be stored separately from the Markdown file.',
    );
  });

  register('markdownAnnotate.cyclePreviewTheme', async () => {
    const order = ['auto', 'light', 'dark'] as const;
    await setPreviewTheme(order[(order.indexOf(previewTheme()) + 1) % order.length]);
  });

  register('markdownAnnotate.revealHighlight', async (item: HighlightItem) => {
    const { uri, highlight } = item;
    const preview = previews.get(uri);
    if (preview) {
      preview.focusHighlight(highlight.id);
    }
    const doc = await vscode.workspace.openTextDocument(uri);
    const editor = vscode.window.visibleTextEditors.find((e) => e.document.uri.toString() === uri.toString());
    if (!editor && preview) {
      return;
    }
    const range = highlight.ranges.length
      ? new vscode.Range(doc.positionAt(highlight.ranges[0].start), doc.positionAt(highlight.ranges[highlight.ranges.length - 1].end))
      : new vscode.Range(highlight.line, 0, highlight.line, 0);
    const shown = editor ?? (await vscode.window.showTextDocument(doc));
    shown.selection = new vscode.Selection(range.start, range.start);
    shown.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
  });

  register('markdownAnnotate.changeHighlightColor', async (item: HighlightItem) => {
    const picked = await vscode.window.showQuickPick(
      palette().map((c) => ({ label: capitalise(c.name), description: c.name === item.highlight.color ? 'current' : undefined, name: c.name })),
      { placeHolder: 'Highlight colour' },
    );
    if (picked) {
      await service.update(await vscode.workspace.openTextDocument(item.uri), item.highlight.id, { color: picked.name });
    }
  });

  register('markdownAnnotate.editHighlightNote', async (item: HighlightItem) => {
    const note = await vscode.window.showInputBox({
      prompt: 'Note for this highlight (leave empty to remove)',
      value: item.highlight.note ?? '',
    });
    if (note !== undefined) {
      await service.update(await vscode.workspace.openTextDocument(item.uri), item.highlight.id, { note: note.trim() });
    }
  });

  register('markdownAnnotate.deleteHighlight', async (item: HighlightItem) => {
    await service.remove(await vscode.workspace.openTextDocument(item.uri), item.highlight.id);
  });

  // Exposed for integration tests.
  return { service, previews };
}

export function deactivate(): void {}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}
