import * as assert from 'assert';
import * as vscode from 'vscode';
import type { HighlightService } from '../../../src/highlights';
import type { PreviewManager } from '../../../src/preview';

suite('Markdown Annotate', () => {
  let api: { service: HighlightService; previews: PreviewManager };
  let doc: vscode.TextDocument;

  suiteSetup(async () => {
    const ext = vscode.extensions.all.find((e) => e.packageJSON.name === 'vscode-markdown-annotate');
    assert.ok(ext, 'extension not found');
    const [file] = await vscode.workspace.findFiles('sample.md');
    doc = await vscode.workspace.openTextDocument(file);
    await vscode.window.showTextDocument(doc);
    api = await ext.activate();
  });

  test('opens the annotatable preview', async () => {
    await vscode.commands.executeCommand('markdownAnnotate.openPreviewToSide');
    assert.ok(api.previews.get(doc.uri));
  });

  test('stores a highlight without touching the file', async () => {
    const before = doc.getText();
    await api.service.create(doc, { exact: 'brown fox jumps over the lazy', prefix: 'The quick ', suffix: ' dog' }, 2, 'green');
    assert.strictEqual(doc.getText(), before);
    const [h] = await api.service.resolve(doc);
    assert.strictEqual(h.source, 'store');
    assert.strictEqual(h.orphaned, false);
  });

  test('writes stored highlights into the file and back out', async () => {
    await vscode.commands.executeCommand('markdownAnnotate.writeHighlightsToFile');
    assert.match(doc.getText(), /<mark data-hl="green" data-hl-id="\w+"[^>]*>brown fox jumps over the<\/mark> \*\*<mark[^>]*>lazy<\/mark> dog\*\*/);
    let [h] = await api.service.resolve(doc);
    assert.strictEqual(h.source, 'file');
    assert.strictEqual(h.text, 'brown fox jumps over the lazy');

    await api.service.update(doc, h.id, { color: 'blue', note: 'a note' });
    assert.match(doc.getText(), /data-hl="blue"[^>]*title="a note"/);

    await vscode.commands.executeCommand('markdownAnnotate.moveHighlightsOutOfFile');
    assert.ok(!doc.getText().includes('<mark'));
    [h] = await api.service.resolve(doc);
    assert.strictEqual(h.source, 'store');
    assert.strictEqual(h.color, 'blue');
    assert.strictEqual(h.note, 'a note');
  });

  test('writes directly into the file when enabled', async () => {
    await vscode.workspace.getConfiguration('markdownAnnotate').update('writeToFile', true, vscode.ConfigurationTarget.Workspace);
    try {
      await api.service.create(doc, { exact: 'Fixture', prefix: '', suffix: '' }, 0, 'pink');
      assert.match(doc.getText(), /^# <mark data-hl="pink"[^>]*>Fixture<\/mark>/);
    } finally {
      await vscode.workspace.getConfiguration('markdownAnnotate').update('writeToFile', undefined, vscode.ConfigurationTarget.Workspace);
    }
  });

  test('exports highlights as Markdown', async () => {
    const md = await api.service.exportMarkdown(doc);
    assert.match(md, /## Pink[\s\S]*> Fixture/);
    assert.match(md, /## Blue[\s\S]*> brown fox jumps over the lazy[\s\S]*a note/);
  });

  test('removes highlights', async () => {
    for (const h of await api.service.resolve(doc)) {
      await api.service.remove(doc, h.id);
    }
    assert.strictEqual((await api.service.resolve(doc)).length, 0);
    assert.ok(!doc.getText().includes('<mark'));
  });
});
