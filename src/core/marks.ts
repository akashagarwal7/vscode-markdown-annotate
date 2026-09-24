/**
 * Highlights written into the Markdown source as `<mark data-hl="…">` tags.
 *
 * One highlight may be written as several `<mark>` pieces (sharing a
 * `data-hl-id`) when a single tag would cut across Markdown syntax, e.g. a
 * selection that starts inside `**bold**` and ends outside it.
 */
import { CONTEXT_LENGTH, QuoteMatch, TextQuote } from './anchor';
import { inRanges, lineAt, SourceRange, TextMap } from './markdown';

export interface MarkAttrs {
  id: string;
  color: string;
  note?: string;
}

export interface MarkPiece extends MarkAttrs {
  openStart: number;
  openEnd: number;
  closeStart: number;
  closeEnd: number;
}

export interface Edit {
  offset: number;
  length: number;
  text: string;
}

export const CLOSE_TAG = '</mark>';

export function newId(): string {
  return Math.random().toString(36).slice(2, 8).padEnd(6, '0');
}

function escapeAttr(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/\r?\n/g, '&#10;');
}

function unescapeAttr(value: string): string {
  return value
    .replace(/&#10;/g, '\n')
    .replace(/&quot;/g, '"')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** `style` is an optional inline CSS declaration list, for other renderers. */
export function openTag(attrs: MarkAttrs, style?: string): string {
  let tag = `<mark data-hl="${escapeAttr(attrs.color)}" data-hl-id="${escapeAttr(attrs.id)}"`;
  if (attrs.note) {
    tag += ` title="${escapeAttr(attrs.note)}"`;
  }
  if (style) {
    tag += ` style="${escapeAttr(style)}"`;
  }
  return tag + '>';
}

/** Find every `<mark data-hl>` piece in the source, outside code. */
export function parseMarks(map: TextMap): MarkPiece[] {
  const { source } = map;
  const pieces: MarkPiece[] = [];
  const stack: { start: number; end: number; attrs: Record<string, string> }[] = [];
  for (const m of source.matchAll(/<mark\b([^<>]*)>|<\/mark\s*>/gi)) {
    const start = m.index!;
    if (inRanges(map.codeBlocks, start) || inRanges(map.codeSpans, start)) {
      continue;
    }
    const end = start + m[0].length;
    if (m[1] !== undefined) {
      const attrs: Record<string, string> = {};
      for (const a of m[1].matchAll(/([^\s="']+)\s*=\s*"([^"]*)"/g)) {
        attrs[a[1].toLowerCase()] = unescapeAttr(a[2]);
      }
      stack.push({ start, end, attrs });
      continue;
    }
    const open = stack.pop();
    if (!open || open.attrs['data-hl'] === undefined) {
      continue;
    }
    pieces.push({
      id: open.attrs['data-hl-id'] || `pos${open.start}`,
      color: open.attrs['data-hl'],
      note: open.attrs['title'] || undefined,
      openStart: open.start,
      openEnd: open.end,
      closeStart: start,
      closeEnd: end,
    });
  }
  return pieces.sort((a, b) => a.openStart - b.openStart);
}

export function groupPieces(pieces: MarkPiece[]): Map<string, MarkPiece[]> {
  const groups = new Map<string, MarkPiece[]>();
  for (const p of pieces) {
    const list = groups.get(p.id);
    if (list) {
      list.push(p);
    } else {
      groups.set(p.id, [p]);
    }
  }
  return groups;
}

export interface FileHighlight extends MarkAttrs {
  quote: TextQuote;
  line: number;
  pieces: MarkPiece[];
}

/** Describe the file's `<mark>` highlights in the same terms as stored ones. */
export function fileHighlights(map: TextMap, pieces = parseMarks(map)): FileHighlight[] {
  const result: FileHighlight[] = [];
  for (const [id, group] of groupPieces(pieces)) {
    let first = -1;
    let last = -1;
    for (let i = 0; i < map.src.length; i++) {
      const s = map.src[i];
      if (s >= 0 && group.some((p) => s >= p.openEnd && s < p.closeStart)) {
        if (first < 0) {
          first = i;
        }
        last = i;
      }
    }
    const quote =
      first < 0
        ? { exact: '', prefix: '', suffix: '' }
        : quoteFromChars(map, { start: first, end: last + 1 });
    result.push({
      id,
      color: group[0].color,
      note: group.find((p) => p.note)?.note,
      quote,
      line: lineAt(map.lineStarts, group[0].openStart),
      pieces: group,
    });
  }
  return result;
}

export function quoteFromChars(map: TextMap, match: QuoteMatch): TextQuote {
  const a = map.rawIndex[match.start];
  const b = map.rawIndex[match.end - 1] + 1;
  return {
    exact: map.raw.slice(a, b),
    prefix: map.raw.slice(Math.max(0, a - CONTEXT_LENGTH), a),
    suffix: map.raw.slice(b, b + CONTEXT_LENGTH),
  };
}

// ─── Mapping a match to source ranges ───────────────────────────────────────

export type SourcePlan = { ok: true; ranges: SourceRange[] } | { ok: false; reason: string };

interface SegmentSpan extends SourceRange {
  seg: number;
}

/** Source range covered by a match, one per rendered segment (block/cell). */
function segmentSpans(map: TextMap, match: QuoteMatch): SegmentSpan[] | string {
  const spans: SegmentSpan[] = [];
  for (let i = match.start; i < match.end; i++) {
    const s = map.src[i];
    if (s < 0) {
      continue;
    }
    const last = spans[spans.length - 1];
    if (last && last.seg === map.seg[i]) {
      last.end = s + 1;
    } else {
      spans.push({ seg: map.seg[i], start: s, end: s + 1 });
    }
  }
  if (!spans.length) {
    return 'the highlighted text could not be found in the source';
  }
  if (spans.some((s) => map.segments[s.seg].kind === 'code')) {
    return 'highlights inside code blocks cannot be written into the file';
  }
  return spans;
}

/** Source ranges covered by a match (used for editor decorations). */
export function sourceSpans(map: TextMap, match: QuoteMatch): SourceRange[] {
  const spans = segmentSpans(map, match);
  return typeof spans === 'string' ? [] : spans;
}

const EMPHASIS = '*_~';

/**
 * Work out where `<mark>` tags can go so the highlight covers `match` without
 * breaking the surrounding Markdown.
 */
export function planMarks(map: TextMap, match: QuoteMatch): SourcePlan {
  const spans = segmentSpans(map, match);
  if (typeof spans === 'string') {
    return { ok: false, reason: spans };
  }
  const ranges = spans.flatMap((span) => fitRange(map, snapToCode(map, span), map.segments[span.seg]));
  return { ok: true, ranges };
}

/** Tags inside a code span render literally, so widen to the whole span. */
function snapToCode(map: TextMap, range: SourceRange): SourceRange {
  let { start, end } = range;
  for (const span of map.codeSpans) {
    if (span.start < start && start < span.end) {
      start = span.start;
    }
    if (span.start < end && end < span.end) {
      end = span.end;
    }
  }
  return { start, end };
}

function fitRange(map: TextMap, range: SourceRange, bounds: SourceRange): SourceRange[] {
  const left = expandLeft(map, range.start, bounds.start);
  const right = expandRight(map, range.end, bounds.end);
  const candidates = [range, { start: left, end: range.end }, { start: range.start, end: right }, { start: left, end: right }];
  for (const c of candidates) {
    if (isBalanced(map, c)) {
      return [c];
    }
  }
  return contentRuns(map, range);
}

function isSyntax(map: TextMap, i: number): boolean {
  return !map.content[i] && !/\s/.test(map.source[i]);
}

function expandLeft(map: TextMap, start: number, limit: number): number {
  while (start > limit && !map.content[start - 1] && (map.masked[start - 1] || (EMPHASIS + '[').includes(map.source[start - 1]))) {
    start--;
  }
  return start;
}

function expandRight(map: TextMap, end: number, limit: number): number {
  while (end < limit && !map.content[end] && (map.masked[end] || (EMPHASIS + ']').includes(map.source[end]))) {
    end++;
  }
  return end;
}

const VOID_TAGS = new Set(['br', 'img', 'hr', 'input', 'wbr', 'source', 'col', 'area', 'meta', 'link']);

/** Would wrapping `range` in one tag keep the inline Markdown intact? */
export function isBalanced(map: TextMap, range: SourceRange): boolean {
  const { source } = map;
  const counts: Record<string, number> = { '*': 0, _: 0, '~': 0 };
  let brackets = 0;
  const tags: string[] = [];
  for (let i = range.start; i < range.end; ) {
    const span = inRanges(map.codeSpans, i);
    if (span) {
      if (span.start < range.start || span.end > range.end) {
        return false;
      }
      i = span.end;
      continue;
    }
    if (!isSyntax(map, i)) {
      i++;
      continue;
    }
    const ch = source[i];
    if (map.masked[i]) {
      const tag = ch === '<' ? /^<(\/?)([A-Za-z][A-Za-z0-9-]*)[^<>]*?(\/?)>/.exec(source.slice(i, i + 2000)) : null;
      if (tag) {
        const name = tag[2].toLowerCase();
        if (!tag[3] && !VOID_TAGS.has(name)) {
          if (!tag[1]) {
            tags.push(name);
          } else if (tags.pop() !== name) {
            return false;
          }
        }
        i += tag[0].length;
        continue;
      }
      i++;
      continue;
    }
    if (ch in counts) {
      // A delimiter run (`**`, `~~`) opens or closes once, however long.
      if (source[i - 1] !== ch || i === range.start) {
        counts[ch]++;
      }
    } else if (ch === '[') {
      brackets++;
    } else if (ch === ']') {
      if (--brackets < 0) {
        return false;
      }
    } else if (ch === '`') {
      return false;
    }
    i++;
  }
  return brackets === 0 && tags.length === 0 && Object.values(counts).every((n) => n % 2 === 0);
}

/** Split a range into runs of rendered text, never crossing syntax. */
function contentRuns(map: TextMap, range: SourceRange): SourceRange[] {
  const runs: SourceRange[] = [];
  let run: SourceRange | undefined;
  for (let i = range.start; i < range.end; ) {
    const span = inRanges(map.codeSpans, i);
    if (span) {
      run ??= { start: span.start, end: span.end };
      run.end = span.end;
      i = span.end;
      continue;
    }
    if (map.content[i]) {
      run ??= { start: i, end: i + 1 };
      run.end = i + 1;
    } else if (!/\s/.test(map.source[i])) {
      if (run) {
        runs.push(run);
      }
      run = undefined;
    }
    i++;
  }
  if (run) {
    runs.push(run);
  }
  return runs;
}

// ─── Edits ──────────────────────────────────────────────────────────────────

export function insertEdits(ranges: SourceRange[], attrs: MarkAttrs, style?: string): Edit[] {
  const open = openTag(attrs, style);
  return ranges.flatMap((r) => [
    { offset: r.start, length: 0, text: open },
    { offset: r.end, length: 0, text: CLOSE_TAG },
  ]);
}

export function removeEdits(pieces: MarkPiece[]): Edit[] {
  return pieces.flatMap((p) => [
    { offset: p.openStart, length: p.openEnd - p.openStart, text: '' },
    { offset: p.closeStart, length: p.closeEnd - p.closeStart, text: '' },
  ]);
}

export function retagEdits(pieces: MarkPiece[], attrs: MarkAttrs, style?: string): Edit[] {
  const open = openTag(attrs, style);
  return pieces.map((p) => ({ offset: p.openStart, length: p.openEnd - p.openStart, text: open }));
}

/** Apply non-overlapping edits expressed against the original text. */
export function applyEdits(text: string, edits: Edit[]): string {
  // Stable sort so inserts at the same offset keep their order
  // (a close tag followed by the next piece's open tag).
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.offset - a.e.offset || b.i - a.i);
  let out = text;
  for (const { e } of sorted) {
    out = out.slice(0, e.offset) + e.text + out.slice(e.offset + e.length);
  }
  return out;
}
