/**
 * Persistence for highlights that are not written into the Markdown file.
 *
 * - `workspace` (default): VS Code's per-workspace storage; nothing on disk
 *   in the project.
 * - `sidecar`: a `<file>.md.annotations.json` next to the document, so
 *   highlights can be committed and shared.
 */
import * as vscode from 'vscode';
import { storageMode } from './config';
import type { StoredHighlight } from './protocol';

const SIDECAR_SUFFIX = '.annotations.json';
const STATE_PREFIX = 'highlights:';

interface SidecarFile {
  version: 1;
  highlights: StoredHighlight[];
}

export class HighlightStore implements vscode.Disposable {
  private readonly cache = new Map<string, StoredHighlight[]>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri | undefined>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  /** Fires with the document whose highlights changed, or undefined for "everything". */
  readonly onDidChange = this.emitter.event;

  constructor(private readonly state: vscode.Memento) {
    const watcher = vscode.workspace.createFileSystemWatcher(`**/*${SIDECAR_SUFFIX}`);
    const reload = (sidecar: vscode.Uri) => void this.reloadSidecar(sidecar);
    this.disposables.push(
      watcher,
      watcher.onDidChange(reload),
      watcher.onDidCreate(reload),
      watcher.onDidDelete(reload),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('markdownAnnotate.storage')) {
          this.cache.clear();
          this.emitter.fire(undefined);
        }
      }),
      vscode.workspace.onDidRenameFiles((e) => {
        for (const { oldUri, newUri } of e.files) {
          void this.move(oldUri, newUri);
        }
      }),
    );
  }

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  async get(uri: vscode.Uri): Promise<StoredHighlight[]> {
    const key = uri.toString();
    let list = this.cache.get(key);
    if (!list) {
      list = storageMode() === 'sidecar' ? await readSidecar(sidecarUri(uri)) : this.state.get(STATE_PREFIX + key, []);
      this.cache.set(key, list);
    }
    return list;
  }

  async set(uri: vscode.Uri, highlights: StoredHighlight[]): Promise<void> {
    const key = uri.toString();
    this.cache.set(key, highlights);
    if (storageMode() === 'sidecar') {
      await writeSidecar(sidecarUri(uri), highlights);
    } else {
      await this.state.update(STATE_PREFIX + key, highlights.length ? highlights : undefined);
    }
    this.emitter.fire(uri);
  }

  async add(uri: vscode.Uri, highlight: StoredHighlight): Promise<void> {
    await this.set(uri, [...(await this.get(uri)), highlight]);
  }

  async update(uri: vscode.Uri, id: string, patch: Partial<StoredHighlight>): Promise<boolean> {
    const list = await this.get(uri);
    if (!list.some((h) => h.id === id)) {
      return false;
    }
    await this.set(uri, list.map((h) => (h.id === id ? { ...h, ...patch } : h)));
    return true;
  }

  async remove(uri: vscode.Uri, id: string): Promise<boolean> {
    const list = await this.get(uri);
    const next = list.filter((h) => h.id !== id);
    if (next.length === list.length) {
      return false;
    }
    await this.set(uri, next);
    return true;
  }

  private async move(oldUri: vscode.Uri, newUri: vscode.Uri): Promise<void> {
    if (storageMode() === 'sidecar') {
      // Sidecars sit next to the file; follow the rename if there is one.
      try {
        await vscode.workspace.fs.rename(sidecarUri(oldUri), sidecarUri(newUri));
      } catch {
        return;
      }
      this.cache.delete(oldUri.toString());
      this.cache.delete(newUri.toString());
      this.emitter.fire(newUri);
      return;
    }
    const list = await this.get(oldUri);
    if (list.length) {
      await this.set(newUri, list);
      await this.set(oldUri, []);
    }
  }

  private async reloadSidecar(sidecar: vscode.Uri): Promise<void> {
    if (storageMode() !== 'sidecar') {
      return;
    }
    const doc = sidecar.with({ path: sidecar.path.slice(0, -SIDECAR_SUFFIX.length) });
    const key = doc.toString();
    const fresh = await readSidecar(sidecar);
    // Ignore the echo of our own writes.
    if (JSON.stringify(fresh) === JSON.stringify(this.cache.get(key) ?? [])) {
      return;
    }
    this.cache.set(key, fresh);
    this.emitter.fire(doc);
  }
}

export function sidecarUri(doc: vscode.Uri): vscode.Uri {
  return doc.with({ path: doc.path + SIDECAR_SUFFIX });
}

async function readSidecar(uri: vscode.Uri): Promise<StoredHighlight[]> {
  try {
    const data = JSON.parse(Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8')) as SidecarFile;
    return Array.isArray(data.highlights) ? data.highlights : [];
  } catch {
    return [];
  }
}

async function writeSidecar(uri: vscode.Uri, highlights: StoredHighlight[]): Promise<void> {
  if (!highlights.length) {
    try {
      await vscode.workspace.fs.delete(uri);
    } catch {
      // Nothing to delete.
    }
    return;
  }
  const data: SidecarFile = { version: 1, highlights };
  await vscode.workspace.fs.writeFile(uri, Buffer.from(JSON.stringify(data, null, 2) + '\n', 'utf8'));
}
