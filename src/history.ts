/**
 * Undo and redo for what was done in a preview: each step keeps the file's
 * text and stored highlights from before and after it, so a highlight written
 * into the file and one stored separately undo the same way.
 */
import * as vscode from 'vscode';
import type { StoredHighlight } from './protocol';
import type { HighlightStore } from './store';

interface Snapshot {
  text: string;
  stored: readonly StoredHighlight[];
}

interface Step {
  label: string;
  uri: vscode.Uri;
  before: Snapshot;
  after: Snapshot;
}

/** Steps kept, at most. */
const MAX_STEPS = 100;

export class EditHistory {
  private done: Step[] = [];
  private undone: Step[] = [];

  constructor(private readonly store: HighlightStore) {}

  get state(): { undo?: string; redo?: string } {
    return { undo: this.done.at(-1)?.label, redo: this.undone.at(-1)?.label };
  }

  /** Run `change` on `doc` and remember it as a step, if it changed anything. */
  async record(label: string, doc: vscode.TextDocument, change: () => Promise<unknown>): Promise<void> {
    const before = await this.snapshot(doc);
    await change();
    const after = await this.snapshot(doc);
    if (before.text === after.text && sameStored(before.stored, after.stored)) {
      return;
    }
    this.done.push({ label, uri: doc.uri, before, after });
    this.done.splice(0, this.done.length - MAX_STEPS);
    this.undone = [];
  }

  /** Undo the last step; returns the file it changed. */
  undo(): Promise<vscode.Uri | undefined> {
    return this.move(this.done, this.undone, 'after', 'before');
  }

  redo(): Promise<vscode.Uri | undefined> {
    return this.move(this.undone, this.done, 'before', 'after');
  }

  private async move(from: Step[], to: Step[], now: 'before' | 'after', next: 'before' | 'after'): Promise<vscode.Uri | undefined> {
    const step = from.pop();
    if (!step) {
      return undefined;
    }
    const doc = await vscode.workspace.openTextDocument(step.uri);
    const text = doc.getText();
    // Typing in the editor since would be lost; the steps for this file no longer apply.
    if (text !== step[now].text) {
      this.forget(step.uri);
      const name = vscode.workspace.asRelativePath(step.uri);
      void vscode.window.showWarningMessage(`Markdown Annotate: can't ${next === 'before' ? 'undo' : 'redo'}, ${name} has been edited since.`);
      return undefined;
    }
    await replaceChanged(doc, step[next].text);
    if (!sameStored(await this.store.get(step.uri), step[next].stored)) {
      await this.store.set(step.uri, [...step[next].stored]);
    }
    to.push(step);
    return step.uri;
  }

  private forget(uri: vscode.Uri): void {
    const other = (s: Step) => s.uri.toString() !== uri.toString();
    this.done = this.done.filter(other);
    this.undone = this.undone.filter(other);
  }

  private async snapshot(doc: vscode.TextDocument): Promise<Snapshot> {
    return { text: doc.getText(), stored: await this.store.get(doc.uri) };
  }
}

function sameStored(a: readonly StoredHighlight[], b: readonly StoredHighlight[]): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}

/** Make `doc` read `text`, replacing only the part that differs, so the editor keeps its place. */
async function replaceChanged(doc: vscode.TextDocument, text: string): Promise<void> {
  const old = doc.getText();
  if (old === text) {
    return;
  }
  let start = 0;
  while (start < old.length && start < text.length && old[start] === text[start]) {
    start++;
  }
  let end = 0;
  while (end < old.length - start && end < text.length - start && old[old.length - 1 - end] === text[text.length - 1 - end]) {
    end++;
  }
  const edit = new vscode.WorkspaceEdit();
  const range = new vscode.Range(doc.positionAt(start), doc.positionAt(old.length - end));
  edit.replace(doc.uri, range, text.slice(start, text.length - end));
  await vscode.workspace.applyEdit(edit);
}
