import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { runTests } from '@vscode/test-electron';

async function main() {
  const root = path.resolve(__dirname, '../../..');
  const workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'md-annotate-'));
  fs.copyFileSync(path.join(root, 'test/fixtures/sample.md'), path.join(workspace, 'sample.md'));
  try {
    await runTests({
      extensionDevelopmentPath: root,
      extensionTestsPath: path.join(__dirname, 'suite/index'),
      launchArgs: [workspace, '--disable-extensions', '--skip-welcome', '--skip-release-notes'],
      // Reuse an already-downloaded VS Code when one is provided.
      ...(process.env.VSCODE_TEST_PATH ? { vscodeExecutablePath: process.env.VSCODE_TEST_PATH } : {}),
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  } finally {
    fs.rmSync(workspace, { recursive: true, force: true });
  }
}

void main();
