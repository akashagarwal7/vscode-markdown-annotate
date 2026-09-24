import * as assert from 'assert';
import { findQuote, quoteFromRange, strip, TextQuote } from '../../src/core/anchor';
import { blankFrontMatter, buildTextMap, createMarkdown, renderMarkdown } from '../../src/core/markdown';
import {
  applyEdits,
  fileHighlights,
  insertEdits,
  parseMarks,
  planMarks,
  removeEdits,
  retagEdits,
} from '../../src/core/marks';

const md = createMarkdown();

function quote(exact: string, prefix = '', suffix = ''): TextQuote {
  return { exact, prefix, suffix };
}

/** Highlight `exact` in `source` and return the rewritten source. */
function mark(source: string, q: TextQuote | string, id = 'abc123', color = 'yellow'): string {
  const map = buildTextMap(md, source);
  const match = findQuote(map.chars, typeof q === 'string' ? quote(q) : q);
  assert.ok(match, `quote not found: ${JSON.stringify(q)}`);
  const plan = planMarks(map, match);
  assert.ok(plan.ok, plan.ok ? '' : plan.reason);
  return applyEdits(source, insertEdits(plan.ranges, { id, color }));
}

/** Rendered text of a snippet, whitespace collapsed. */
function text(source: string): string {
  return renderMarkdown(md, source)
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Text inside the highlight marks of the rendered HTML, whitespace-free. */
function markedText(source: string): string {
  const html = renderMarkdown(md, source);
  let out = '';
  for (const m of html.matchAll(/<mark[^>]*>([\s\S]*?)<\/mark>/g)) {
    out += m[1].replace(/<[^>]+>/g, '');
  }
  return strip(out).chars;
}

suite('anchor', () => {
  test('matches ignoring whitespace', () => {
    const hay = strip('Hello   big\n world').chars;
    assert.deepStrictEqual(findQuote(hay, quote('big world')), { start: 5, end: 13 });
  });

  test('uses prefix/suffix to disambiguate', () => {
    const hay = strip('one cat here, two cat there').chars;
    const m = findQuote(hay, quote('cat', 'two ', ' there'));
    assert.strictEqual(m?.start, hay.lastIndexOf('cat'));
  });

  test('uses distance as a tie-breaker', () => {
    const hay = strip('cat cat cat').chars;
    const m = findQuote(hay, quote('cat'), (i) => Math.abs(i - 6));
    assert.strictEqual(m?.start, 6);
  });

  test('returns undefined for missing or empty quotes', () => {
    assert.strictEqual(findQuote('abc', quote('zzz')), undefined);
    assert.strictEqual(findQuote('abc', quote('  ')), undefined);
  });

  test('quoteFromRange trims and captures context', () => {
    assert.deepStrictEqual(quoteFromRange('aa  bb  cc', 2, 8), { exact: 'bb', prefix: 'aa  ', suffix: '  cc' });
    assert.strictEqual(quoteFromRange('a   b', 1, 4), undefined);
  });
});

suite('markdown', () => {
  test('front matter is blanked but offsets are kept', () => {
    const src = '---\ntitle: x\n---\n# Hi';
    const out = blankFrontMatter(src);
    assert.strictEqual(out.length, src.length);
    assert.ok(out.endsWith('# Hi'));
    assert.ok(!renderMarkdown(md, src).includes('title'));
  });

  test('blocks carry data-line and headings get ids', () => {
    const html = renderMarkdown(md, '# Hello World\n\ntext\n\n# Hello World');
    assert.match(html, /<h1 data-line="0" id="hello-world">/);
    assert.match(html, /<p data-line="2">/);
    assert.match(html, /id="hello-world-1"/);
  });

  test('images are resolved through the env', () => {
    const html = renderMarkdown(md, '![alt](img.png)', { resolveImage: (s) => `res://${s}` });
    assert.match(html, /src="res:\/\/img.png"/);
  });

  test('text map aligns rendered text to source', () => {
    const src = '# Title\n\nSome **bold** and [a link](http://x.y) &amp; `code`.\n';
    const map = buildTextMap(md, src);
    assert.strictEqual(map.chars, strip('Title Some bold and a link & code.').chars);
    for (let i = 0; i < map.chars.length; i++) {
      if (map.src[i] >= 0) {
        assert.strictEqual(src[map.src[i]], map.chars[i], `char ${i}`);
      }
    }
  });

  test('fenced code is syntax highlighted without changing its text', () => {
    const src = '```ts\nconst answer: number = 42; // yes <b>\n```\n';
    const html = renderMarkdown(md, src);
    assert.match(html, /<code data-line="0" class="language-ts"><span class="hljs-keyword">const<\/span>/);
    const text = html.replace(/<[^>]+>/g, '').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    assert.strictEqual(text, 'const answer: number = 42; // yes <b>\n\n');
  });

  test('unknown languages and plain text render as escaped plain text', () => {
    assert.match(renderMarkdown(md, '```nosuchlang\n<x>\n```\n'), /<code data-line="0" class="language-nosuchlang">&lt;x&gt;/);
    assert.ok(!renderMarkdown(md, '```text\nimport os\ndef f(): pass\n```\n').includes('hljs'));
  });

  test('bash colours command names and flags', () => {
    const html = renderMarkdown(md, '```bash\nnpm install --save x\ncd dir && git status -s\nNAME=1 echo hi | tee log\nif [ -f a ]; then rm a; fi\n```\n');
    const commands = [...html.matchAll(/hljs-title function_">([^<]+)</g)].map((m) => m[1]);
    assert.deepStrictEqual(commands, ['npm', 'cd', 'git', 'tee', 'rm']);
    const flags = [...html.matchAll(/hljs-attr">([^<]+)</g)].map((m) => m[1]);
    assert.deepStrictEqual(flags, ['--save', '-s', '-f']);
    assert.match(html, /hljs-keyword">if</);
  });

  test('shell/console fences are Bash unless they show prompts', () => {
    assert.match(renderMarkdown(md, '```shell\nnpm install\n```\n'), /hljs-title function_">npm</);
    assert.match(renderMarkdown(md, '```console\n$ npm test\nok\n```\n'), /hljs-meta prompt_">\$ </);
  });

  test('untagged fences are auto-detected', () => {
    const python = renderMarkdown(md, '```\nimport os\n\ndef main(argv):\n    for arg in argv:\n        print(f"{arg}")\n    return None\n```\n');
    assert.match(python, /hljs-keyword">def</);
    const json = renderMarkdown(md, '```\n{\n  "name": "demo",\n  "version": "1.0.0",\n  "private": true\n}\n```\n');
    assert.match(json, /hljs-(attr|string)/);
    assert.match(renderMarkdown(md, '```\nname: CI\non:\n  push:\n    branches: [master]\n```\n'), /hljs-attr">name:</);
    // Prose has too little signal: stays plain rather than risk wrong colours.
    for (const prose of ['hello world', 'This is just some text in a block.', 'src/\n  core/\n    anchor.ts']) {
      assert.ok(!renderMarkdown(md, '```\n' + prose + '\n```\n').includes('hljs'), prose);
    }
  });

  test('ordered list markers are not mistaken for content', () => {
    const src = '1. 1984 was a year\n';
    const map = buildTextMap(md, src);
    assert.strictEqual(map.src[0], src.indexOf('1984'));
  });
});

suite('marks', () => {
  test('wraps plain text', () => {
    const out = mark('Hello brave new world.\n', 'brave new');
    assert.strictEqual(out, 'Hello <mark data-hl="yellow" data-hl-id="abc123">brave new</mark> world.\n');
  });

  test('widens over emphasis when the selection covers it', () => {
    const out = mark('foo **bar** baz\n', 'bar baz');
    assert.strictEqual(out, 'foo <mark data-hl="yellow" data-hl-id="abc123">**bar** baz</mark>\n');
    assert.strictEqual(markedText(out), 'barbaz');
  });

  test('splits into pieces when a selection starts inside emphasis', () => {
    const out = mark('**bold text** plain\n', 'text plain');
    assert.strictEqual(markedText(out), 'textplain');
    assert.strictEqual(text(out), 'bold text plain');
    assert.strictEqual(parseMarks(buildTextMap(md, out)).length, 2);
  });

  test('keeps links intact', () => {
    const out = mark('see [the docs](http://x.y/(a)) now\n', 'docs now');
    assert.strictEqual(text(out), 'see the docs now');
    assert.strictEqual(markedText(out), 'docsnow');
    assert.ok(out.includes('(http://x.y/(a))'));
  });

  test('never puts tags inside inline code', () => {
    const out = mark('run `npm install` first\n', 'install');
    assert.strictEqual(out, 'run <mark data-hl="yellow" data-hl-id="abc123">`npm install`</mark> first\n');
  });

  test('splits a multi-paragraph selection per block', () => {
    const out = mark('para one\n\npara two\n', 'one para');
    assert.strictEqual(markedText(out), 'onepara');
    assert.strictEqual(parseMarks(buildTextMap(md, out)).length, 2);
    assert.match(renderMarkdown(md, out), /<p data-line="0">para <mark/);
  });

  test('handles list items, blockquotes, headings and tables', () => {
    for (const [src, q] of [
      ['- item one\n- item two\n', 'item two'],
      ['> quoted line\n> continues here\n', 'line continues'],
      ['## Big heading ##\n', 'Big heading'],
      ['| a | b |\n|---|---|\n| cell | other cell |\n', 'other cell'],
    ]) {
      const out = mark(src, q);
      assert.strictEqual(markedText(out), strip(q).chars, src);
      assert.strictEqual(text(out), text(src), src);
    }
  });

  test('disambiguates repeated text with context', () => {
    const out = mark('the cat sat. the cat ran.\n', quote('cat', 'the ', ' ran'));
    assert.strictEqual(out.indexOf('<mark'), 'the cat sat. the '.length);
  });

  test('refuses to write into code blocks', () => {
    const src = '```\nconst x = 1;\n```\n';
    const map = buildTextMap(md, src);
    const plan = planMarks(map, findQuote(map.chars, quote('const x'))!);
    assert.strictEqual(plan.ok, false);
  });

  test('nests correctly around an existing highlight', () => {
    const once = mark('alpha beta gamma\n', 'beta', 'first1');
    const twice = mark(once, 'alpha beta gamma', 'second', 'green');
    const html = renderMarkdown(md, twice);
    assert.match(html, /<mark data-hl="green" data-hl-id="second">alpha <mark data-hl="yellow" data-hl-id="first1">beta<\/mark> gamma<\/mark>/);

    // Overlapping (not nested) selections still produce well-formed tags.
    const overlap = mark(once, 'beta gamma', 'third3', 'blue');
    assert.strictEqual(text(overlap), 'alpha beta gamma');
    const tags = [...overlap.matchAll(/<\/?mark/g)].map((m) => m[0]);
    let depth = 0;
    for (const t of tags) {
      depth += t === '<mark' ? 1 : -1;
      assert.ok(depth >= 0);
    }
    assert.strictEqual(depth, 0);
  });

  test('parses, retags and removes highlights', () => {
    const src = mark('**bold text** plain\n', 'text plain');
    const map = buildTextMap(md, src);
    const [hl] = fileHighlights(map);
    assert.strictEqual(hl.id, 'abc123');
    assert.strictEqual(hl.quote.exact, 'text plain');
    assert.strictEqual(hl.pieces.length, 2);

    const noted = applyEdits(src, retagEdits(hl.pieces, { id: hl.id, color: 'blue', note: 'say "hi" & <bye>' }));
    const [again] = fileHighlights(buildTextMap(md, noted));
    assert.strictEqual(again.color, 'blue');
    assert.strictEqual(again.note, 'say "hi" & <bye>');

    assert.strictEqual(applyEdits(noted, removeEdits(again.pieces)), '**bold text** plain\n');
  });

  test('ignores marks inside code', () => {
    const src = '`<mark data-hl="x">no</mark>`\n\n```\n<mark data-hl="x">no</mark>\n```\n';
    assert.strictEqual(parseMarks(buildTextMap(md, src)).length, 0);
  });

  test('inline style is emitted for other renderers', () => {
    const map = buildTextMap(md, 'word\n');
    const plan = planMarks(map, findQuote(map.chars, quote('word'))!);
    assert.ok(plan.ok);
    const out = applyEdits('word\n', insertEdits(plan.ranges, { id: 'i', color: 'pink' }, 'background-color:#f9a8d4'));
    assert.strictEqual(out, '<mark data-hl="pink" data-hl-id="i" style="background-color:#f9a8d4">word</mark>\n');
  });
});
