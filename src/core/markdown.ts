/**
 * Markdown parsing/rendering and the rendered-text ↔ source mapping that lets
 * a highlight made on the preview be located (and written back) in the source.
 */
import MarkdownIt = require('markdown-it');
import { strip } from './anchor';
import { highlightCode } from './highlight';

type Token = MarkdownIt.Token;

export interface RenderEnv {
  /** Rewrites an image `src` so the webview can load it. */
  resolveImage?: (src: string) => string;
  slugs?: Map<string, number>;
}

export function createMarkdown(): MarkdownIt {
  const md = new MarkdownIt({ html: true, linkify: true, typographer: false, highlight: highlightCode });

  // Tag every block with its source line, used for line hints, scroll sync
  // and double-click-to-source.
  md.core.ruler.push('annotate_source_lines', (state) => {
    for (const token of state.tokens) {
      if (token.map && token.nesting >= 0 && token.type !== 'inline') {
        token.attrSet('data-line', String(token.map[0]));
      }
    }
  });

  // GitHub-style heading ids so in-document links work.
  md.core.ruler.push('annotate_heading_ids', (state) => {
    const env = state.env as RenderEnv;
    const slugs = (env.slugs ??= new Map());
    const tokens = state.tokens;
    for (let i = 0; i < tokens.length; i++) {
      if (tokens[i].type === 'heading_open' && tokens[i + 1]?.type === 'inline') {
        const base = slugify(tokens[i + 1].content);
        const seen = slugs.get(base) ?? 0;
        slugs.set(base, seen + 1);
        tokens[i].attrSet('id', seen ? `${base}-${seen}` : base);
      }
    }
  });

  const defaultImage = md.renderer.rules.image!;
  md.renderer.rules.image = (tokens, idx, options, env: RenderEnv, self) => {
    const src = tokens[idx].attrGet('src');
    if (src && env?.resolveImage) {
      tokens[idx].attrSet('src', env.resolveImage(src));
    }
    return defaultImage(tokens, idx, options, env, self);
  };

  return md;
}

export function slugify(text: string): string {
  return text
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, '')
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/\s/g, '-');
}

/**
 * Replace a leading YAML front matter block with spaces (newlines kept), so
 * it is not rendered while every source offset stays valid.
 */
/** Source line of the heading a `#fragment` link points to, using the same ids as the preview. */
export function headingLine(md: MarkdownIt, text: string, id: string): number | undefined {
  const heading = md.parse(blankFrontMatter(text), {}).find((t) => t.type === 'heading_open' && t.attrGet('id') === id);
  return heading?.map?.[0];
}

export function blankFrontMatter(text: string): string {
  const m = /^---[ \t]*\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/.exec(text);
  if (!m) {
    return text;
  }
  return m[0].replace(/[^\r\n]/g, ' ') + text.slice(m[0].length);
}

export function renderMarkdown(md: MarkdownIt, text: string, env: RenderEnv = {}): string {
  return md.render(blankFrontMatter(text), env);
}

// ─── Text map ───────────────────────────────────────────────────────────────

export interface Segment {
  /** `code` segments (fenced/indented blocks) can be highlighted but not written to. */
  kind: 'inline' | 'code';
  line: number;
  /** Source range the segment was aligned within. */
  start: number;
  end: number;
}

export interface SourceRange {
  start: number;
  end: number;
}

export interface TextMap {
  source: string;
  /** Rendered text of every block, each followed by `\n`. */
  raw: string;
  /** `raw` without whitespace — the space quotes are matched in. */
  chars: string;
  /** For each of `chars`: index into `raw`. */
  rawIndex: number[];
  /** For each of `chars`: source offset, or -1 when it could not be aligned. */
  src: number[];
  /** For each of `chars`: index into `segments`. */
  seg: number[];
  segments: Segment[];
  lineStarts: number[];
  /** Inline code spans; text inside them is literal, so tags can't go there. */
  codeSpans: SourceRange[];
  /** Fenced/indented code blocks. */
  codeBlocks: SourceRange[];
  /** Source chars that are markup (tags, link targets, entities, images). */
  masked: Uint8Array;
  /** Source chars that are rendered text. */
  content: Uint8Array;
}

export function lineStartsOf(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }
  return starts;
}

export function lineAt(lineStarts: number[], offset: number): number {
  let lo = 0;
  let hi = lineStarts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (lineStarts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

export function inRanges(ranges: SourceRange[], offset: number): SourceRange | undefined {
  return ranges.find((r) => offset >= r.start && offset < r.end);
}

const MASK_PATTERNS: { re: RegExp; skip: number }[] = [
  // Images: alt text is not part of the rendered text.
  { re: /!\[[^\]\n]*\]\((?:[^()\n]|\([^()\n]*\))*\)/g, skip: 0 },
  // HTML comments and tags.
  { re: /<!--[\s\S]*?-->/g, skip: 0 },
  { re: /<\/?[A-Za-z][A-Za-z0-9-]*(?:\s[^<>]*)?\/?>/g, skip: 0 },
  // Inline link destinations and reference labels (the `]` stays visible syntax).
  { re: /\]\((?:[^()\n]|\([^()\n]*\))*\)/g, skip: 1 },
  { re: /\]\[[^\]\n]*\]/g, skip: 1 },
  // Entities render as a different character.
  { re: /&(?:#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, skip: 0 },
];

/** Plain text of an inline token, as the browser's `textContent` would see it. */
function inlineText(children: Token[] | null): string {
  let out = '';
  for (const t of children ?? []) {
    switch (t.type) {
      case 'text':
      case 'text_special':
      case 'code_inline':
        out += t.content;
        break;
      case 'softbreak':
      case 'hardbreak':
        out += '\n';
        break;
    }
  }
  return out;
}

export function buildTextMap(md: MarkdownIt, source: string): TextMap {
  const text = blankFrontMatter(source);
  const tokens = md.parse(text, {});
  const lineStarts = lineStartsOf(text);
  const startOfLine = (line: number) => (line < lineStarts.length ? lineStarts[line] : text.length);

  const codeBlocks: SourceRange[] = [];
  for (const t of tokens) {
    if ((t.type === 'fence' || t.type === 'code_block') && t.map) {
      codeBlocks.push({ start: lineStarts[t.map[0]], end: startOfLine(t.map[1]) });
    }
  }

  const codeSpans: SourceRange[] = [];
  for (const m of text.matchAll(/(`+)(?!`)([\s\S]*?[^`])\1(?!`)/g)) {
    if (!inRanges(codeBlocks, m.index!)) {
      codeSpans.push({ start: m.index!, end: m.index! + m[0].length });
    }
  }

  const masked = new Uint8Array(text.length);
  for (const { re, skip } of MASK_PATTERNS) {
    for (const m of text.matchAll(re)) {
      const start = m.index! + skip;
      if (inRanges(codeBlocks, start) || inRanges(codeSpans, start)) {
        continue;
      }
      masked.fill(1, start, m.index! + m[0].length);
    }
  }

  const map: TextMap = {
    source,
    raw: '',
    chars: '',
    rawIndex: [],
    src: [],
    seg: [],
    segments: [],
    lineStarts,
    codeSpans,
    codeBlocks,
    masked,
    content: new Uint8Array(text.length),
  };
  const rawParts: string[] = [];
  const charParts: string[] = [];
  let rawLength = 0;
  let cursor = 0;

  const align = (plain: string, kind: Segment['kind'], line: number, start: number, end: number) => {
    const segIndex = map.segments.length;
    map.segments.push({ kind, line, start, end });
    const stripped = strip(plain);
    let p = start;
    for (let i = 0; i < stripped.chars.length; i++) {
      const c = stripped.chars[i];
      let q = p;
      while (q < end && (masked[q] || text[q] !== c)) {
        q++;
      }
      if (q < end) {
        map.src.push(q);
        map.content[q] = 1;
        p = q + 1;
      } else {
        map.src.push(-1);
      }
      map.rawIndex.push(rawLength + stripped.index[i]);
      map.seg.push(segIndex);
    }
    charParts.push(stripped.chars);
    rawParts.push(plain, '\n');
    rawLength += plain.length + 1;
    return p;
  };

  // Table-cell inline tokens have no map of their own; use the row's.
  let blockMap: [number, number] | null = null;
  for (const t of tokens) {
    if (t.map && t.type !== 'inline') {
      blockMap = t.map;
    }
    const tokenMap = t.map ?? blockMap;
    if (!tokenMap) {
      continue;
    }
    if (t.type === 'inline') {
      const [l0, l1] = tokenMap;
      const end = startOfLine(l1);
      let start = lineStarts[l0];
      // Several inline tokens can share a line (table cells).
      if (cursor > start && cursor < end) {
        start = cursor;
      }
      const firstLine = t.content.split('\n')[0];
      const found = firstLine ? text.indexOf(firstLine, start) : -1;
      if (found !== -1 && found < startOfLine(l0 + 1)) {
        start = found;
      }
      cursor = align(inlineText(t.children), 'inline', l0, start, end);
    } else if (t.type === 'fence' || t.type === 'code_block') {
      const [l0, l1] = tokenMap;
      const bodyStart = t.type === 'fence' ? l0 + 1 : l0;
      cursor = align(t.content, 'code', bodyStart, startOfLine(bodyStart), startOfLine(l1));
    }
  }

  map.raw = rawParts.join('');
  map.chars = charParts.join('');
  return map;
}
