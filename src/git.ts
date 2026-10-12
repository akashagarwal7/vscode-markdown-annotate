/** Reads committed file contents through VS Code's built-in Git extension. */
import * as vscode from 'vscode';

// The subset of the Git extension's API (extensions/git/src/api/git.d.ts) used here.
interface Repository {
  readonly rootUri: vscode.Uri;
  readonly state: { readonly onDidChange: vscode.Event<void> };
  show(ref: string, path: string): Promise<string>;
}

interface GitAPI {
  readonly state: 'uninitialized' | 'initialized';
  readonly onDidChangeState: vscode.Event<'uninitialized' | 'initialized'>;
  readonly onDidOpenRepository: vscode.Event<Repository>;
  readonly repositories: Repository[];
  getRepository(uri: vscode.Uri): Repository | null;
}

export type BaseResult = { text: string } | { unavailable: string };

export class GitBase implements vscode.Disposable {
  private api?: Promise<GitAPI | undefined>;
  private readonly watched = new WeakSet<Repository>();
  private readonly emitter = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.emitter];

  /** Fires when any repository's state (HEAD, index, …) changes. */
  readonly onDidChange = this.emitter.event;

  dispose(): void {
    this.disposables.forEach((d) => d.dispose());
  }

  /** The file's contents at HEAD. */
  async head(uri: vscode.Uri): Promise<BaseResult> {
    const api = await this.gitApi();
    if (!api) {
      return { unavailable: 'Git is not available' };
    }
    const repo = api.getRepository(uri);
    if (!repo) {
      return { unavailable: 'Not in a git repository' };
    }
    try {
      return { text: await repo.show('HEAD', uri.fsPath) };
    } catch {
      // Untracked, newly added, or no commits yet: everything is new.
      return { text: '' };
    }
  }

  private gitApi(): Promise<GitAPI | undefined> {
    this.api ??= this.load();
    return this.api;
  }

  private async load(): Promise<GitAPI | undefined> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitAPI }>('vscode.git');
    if (!extension) {
      return undefined;
    }
    try {
      const api = (extension.isActive ? extension.exports : await extension.activate()).getAPI(1);
      if (api.state !== 'initialized') {
        await new Promise<void>((resolve) => {
          const listener = api.onDidChangeState((state) => {
            if (state === 'initialized') {
              listener.dispose();
              resolve();
            }
          });
        });
      }
      api.repositories.forEach((r) => this.watch(r));
      this.disposables.push(api.onDidOpenRepository((r) => this.watch(r)));
      return api;
    } catch {
      return undefined;
    }
  }

  private watch(repo: Repository): void {
    if (!this.watched.has(repo)) {
      this.watched.add(repo);
      this.disposables.push(repo.state.onDidChange(() => this.emitter.fire()));
    }
  }
}
