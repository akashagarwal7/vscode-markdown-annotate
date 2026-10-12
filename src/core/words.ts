/**
 * Word diff between the rendered text of an old block and the block that
 * replaced it, for marking what changed within a line, as the editor does.
 */
import { diffLines } from './myers';

export type Range = [start: number, end: number];

/** Below this share of unchanged text, the blocks are unrelated and nothing is marked within them. */
const MIN_SIMILARITY = 0.4;

const TOKEN = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu;

function tokenize(text: string): { tokens: string[]; starts: number[] } {
  const tokens: string[] = [];
  const starts: number[] = [];
  for (const m of text.matchAll(TOKEN)) {
    tokens.push(m[0]);
    starts.push(m.index!);
  }
  return { tokens, starts };
}

const isSpace = (token: string) => !token.trim();

/**
 * Character ranges of the changed tokens; a space between two changes joins
 * them, and spaces at either end are left out.
 */
function ranges(tokens: string[], starts: number[], changed: boolean[]): Range[] {
  const result: Range[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const joins = isSpace(tokens[i]) && changed[i - 1] && changed[i + 1];
    if (isSpace(tokens[i]) ? !joins : !changed[i]) {
      continue;
    }
    const end = starts[i] + tokens[i].length;
    const last = result[result.length - 1];
    if (last && last[1] === starts[i]) {
      last[1] = end;
    } else {
      result.push([starts[i], end]);
    }
  }
  return result;
}

const visible = (tokens: string[], keep: (i: number) => boolean) =>
  tokens.reduce((n, t, i) => (keep(i) && !isSpace(t) ? n + t.length : n), 0);

/**
 * Ranges of `before` that were removed and of `after` that were added, or
 * undefined when the two have too little in common for that to be useful.
 */
export function wordDiff(before: string, after: string): { removed: Range[]; added: Range[] } | undefined {
  const a = tokenize(before);
  const b = tokenize(after);
  const diff = diffLines(a.tokens, b.tokens);
  const total = visible(a.tokens, () => true) + visible(b.tokens, () => true);
  const kept = visible(a.tokens, (i) => !diff.removed[i]) + visible(b.tokens, (i) => !diff.added[i]);
  if (!total || kept / total < MIN_SIMILARITY) {
    return undefined;
  }
  return {
    removed: ranges(a.tokens, a.starts, diff.removed),
    added: ranges(b.tokens, b.starts, diff.added),
  };
}
