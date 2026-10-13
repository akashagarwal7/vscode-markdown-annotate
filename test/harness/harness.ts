// Browser harness: stands in for the extension host so the webview can be
// exercised outside VS Code. Build with `npm run harness`, open test/harness/index.html.
import { findQuote } from '../../src/core/anchor';
import { blockDiff } from '../../src/core/diff';
import { buildTextMap, createMarkdown, renderMarkdown } from '../../src/core/markdown';
import { applyEdits, groupPieces, insertEdits, newId, parseMarks, planMarks, removeEdits, retagEdits } from '../../src/core/marks';
import type { FromWebview, StoredHighlight } from '../../src/protocol';

const md = createMarkdown();
const palette = [
  { name: 'yellow', color: '#fde047' },
  { name: 'green', color: '#86efac' },
  { name: 'blue', color: '#93c5fd' },
  { name: 'pink', color: '#f9a8d4' },
];

const harness = {
  source: `# Sample document

Some **bold text** and a [link](https://example.com) in a paragraph
that wraps onto a second line.

- first item
- second item with \`inline code\`
- links to [the table](#a-table), [a line](#L17) and [another file](other.md#setup)

## A table

> A quoted passage.

| Name | Value |
|------|-------|
| alpha | one |
| beta | two |

\`\`\`js
const answer = 42;
\`\`\`
`,
  stored: [] as StoredHighlight[],
  writeToFile: false,
  theme: 'auto' as 'auto' | 'light' | 'dark',
  /** Stands in for the file at HEAD; the diff view compares against it. */
  base: '',
  diff: false,
  messages: [] as FromWebview[],
};
harness.base = harness.source;
(window as any).__harness = harness;

function send() {
  window.postMessage(
    {
      type: 'render',
      html: renderMarkdown(md, harness.source),
      title: 'sample.md',
      highlights: harness.stored,
      palette,
      writeToFile: harness.writeToFile,
      scrollSync: true,
      theme: harness.theme,
      diff: harness.diff ? { base: 'HEAD', view: blockDiff(md, harness.base, harness.source) } : undefined,
    },
    '*',
  );
}
(window as any).__send = send;

function handle(m: FromWebview) {
  harness.messages.push(m);
  // The extension only moves the editor; nothing to re-render.
  if (m.type === 'scrolled') {
    return;
  }
  // Stands in for another Markdown file next to this one.
  if (m.type === 'peek') {
    const other = '# Other file\n\nIntro.\n\n## Setup\n\nRun <mark data-hl="green">the installer</mark>.\n\n- one\n- two\n\n## Next\n\nLater.\n';
    const html = m.href.startsWith('other.md') ? renderMarkdown(md, other) : undefined;
    window.postMessage({ type: 'peek', id: m.id, title: 'other.md', html, error: html ? undefined : 'File not found' }, '*');
    return;
  }
  const map = buildTextMap(md, harness.source);
  const groups = groupPieces(parseMarks(map));
  switch (m.type) {
    case 'ready':
      harness.diff = !!m.diff;
      break;
    case 'setDiff':
      harness.diff = m.value;
      break;
    case 'create': {
      const h: StoredHighlight = { id: newId(), color: m.color, quote: m.quote, line: m.line, createdAt: Date.now() };
      const match = findQuote(map.chars, m.quote);
      const plan = harness.writeToFile && match ? planMarks(map, match) : undefined;
      if (plan?.ok) {
        harness.source = applyEdits(harness.source, insertEdits(plan.ranges, h));
      } else {
        harness.stored.push(h);
      }
      break;
    }
    case 'update': {
      const pieces = groups.get(m.id);
      if (pieces) {
        harness.source = applyEdits(harness.source, retagEdits(pieces, { id: m.id, color: m.color ?? pieces[0].color, note: m.note ?? pieces[0].note }));
      } else {
        harness.stored = harness.stored.map((h) => (h.id === m.id ? { ...h, ...(m.color ? { color: m.color } : {}), ...(m.note !== undefined ? { note: m.note } : {}) } : h));
      }
      break;
    }
    case 'delete': {
      const pieces = groups.get(m.id);
      if (pieces) {
        harness.source = applyEdits(harness.source, removeEdits(pieces));
      } else {
        harness.stored = harness.stored.filter((h) => h.id !== m.id);
      }
      break;
    }
    case 'setWriteToFile':
      harness.writeToFile = m.value;
      break;
    case 'setTheme':
      harness.theme = m.value;
      break;
  }
  setTimeout(send, 0);
}

// `?demo` seeds a few highlights and opens the colour toolbar (used for the README screenshot).
if (location.search.includes('demo')) {
  document.body.className = location.search.includes('dark') ? 'vscode-dark' : 'vscode-light';
  harness.source = `# Reading notes

Markdown Annotate lets you <mark data-hl="yellow" data-hl-id="demo01">highlight passages in the preview</mark>
using several colours, and attach a note to any highlight.

- Highlights are **stored separately** by default, so the file stays untouched.
- Optionally they are <mark data-hl="green" data-hl-id="demo02" title="Portable: GitHub renders these too">written into the Markdown file</mark> as \`<mark>\` tags.
- The same highlights show up in the source editor and in the sidebar.

> Select any text to pick a colour; click a highlight to recolour it,
> add a note or delete it.

## Git diff

With **Git diff** on, the preview shows what changed since the last commit: edited text gets a green bar, and the words that changed a stronger tint.

| Change | Shown as |
|--------|----------|
| Edited paragraph | the old and new text, words marked |
| Edited table row | just that row |

## On the scrollbar

Changes and highlights are also marked on the scrollbar, in their colours, so a long document shows at a glance where your notes are.

## Keep reading

Highlights stay anchored to their text as the document changes around them, and are re-found by their surrounding words when lines move.

Notes are shown on hover, listed in the sidebar, and included when you export highlights as Markdown.

Write highlights into the file to share them through git; other renderers show them as \`<mark>\` tags.
`;
  // The committed version, so Git diff has something to show.
  harness.base = harness.source
    .replace(
      'edited text gets a green bar, and the words that changed a stronger tint.',
      'new and edited text gets a green bar.',
    )
    .replace('| just that row |', '| the whole table |');
  harness.stored.push({
    id: 'demo03',
    color: 'pink',
    quote: { exact: 'attach a note', prefix: 'and ', suffix: ' to any' },
    createdAt: 1,
    note: 'Notes appear on hover',
  });
  harness.stored.push({
    id: 'demo04',
    color: 'blue',
    quote: { exact: 'export highlights as Markdown', prefix: 'when you ', suffix: '.' },
    createdAt: 2,
    note: 'Grouped by colour, with notes and line numbers',
  });
  window.addEventListener('message', function once(e) {
    if (e.data?.type !== 'render') return;
    window.removeEventListener('message', once);
    setTimeout(() => {
      const walker = document.createTreeWalker(document.getElementById('content')!, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
        const i = n.data.indexOf('pick a colour');
        if (i >= 0) {
          const r = document.createRange();
          r.setStart(n, i);
          r.setEnd(n, i + 'pick a colour'.length);
          getSelection()!.addRange(r);
          document.dispatchEvent(new MouseEvent('mouseup'));
          break;
        }
      }
    }, 50);
  });
}

(window as any).acquireVsCodeApi = () => ({ postMessage: handle, getState: () => undefined, setState: () => {} });
(window as any).__ANNOTATE_STATE__ = { uri: 'file:///sample.md' };
