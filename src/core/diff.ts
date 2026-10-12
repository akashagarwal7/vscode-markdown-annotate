/**
 * Line diff (Myers) and its projection onto top-level Markdown blocks, for
 * showing a rendered diff against a git revision in the preview.
 */
import MarkdownIt = require('markdown-it');
import { blankFrontMatter, RenderEnv } from './markdown';
import type { DiffView } from '../protocol';

export interface LineDiff {
  /** Per line of the new text: not present in the old text. */
  added: boolean[];
  /** Per line of the old text: not present in the new text. */
  removed: boolean[];
  /** Per line of the old text: the new line it sits at (matched, or where it was removed). */
  oldToNew: number[];
}

/** Beyond this many edits the texts are treated as entirely different. */
const MAX_EDITS = 5000;

export function splitLines(text: string): string[] {
  return text.split(/\r?\n/);
}

export function diffLines(a: string[], b: string[]): LineDiff {
  // Common prefix and suffix are the usual case; keep them out of the search.
  let pre = 0;
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) {
    pre++;
  }
  let suf = 0;
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) {
    suf++;
  }
  const ops = myers(a.slice(pre, a.length - suf), b.slice(pre, b.length - suf));

  const result: LineDiff = {
    added: new Array<boolean>(b.length).fill(false),
    removed: new Array<boolean>(a.length).fill(false),
    oldToNew: new Array<number>(a.length).fill(0),
  };
  let i = 0;
  let j = 0;
  const equal = (count: number) => {
    for (let c = 0; c < count; c++) {
      result.oldToNew[i++] = j++;
    }
  };
  equal(pre);
  for (const op of ops) {
    if (op === '=') {
      equal(1);
    } else if (op === '-') {
      result.removed[i] = true;
      result.oldToNew[i++] = j;
    } else {
      result.added[j++] = true;
    }
  }
  equal(suf);
  return result;
}

type Op = '=' | '-' | '+';

/** Shortest edit script from `a` to `b` (Myers, O((N+M)·D)). */
function myers(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const max = Math.min(n + m, MAX_EDITS);
  const off = max + 1;
  const v = new Int32Array(2 * max + 3);
  // trace[d] holds v for k ∈ [-d-1, d+1] as it was before step d.
  const trace: Int32Array[] = [];
  for (let d = 0; d <= max; d++) {
    trace.push(v.slice(off - d - 1, off + d + 2));
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= n && y >= m) {
        return backtrack(trace, n, m);
      }
    }
  }
  return [...new Array<Op>(n).fill('-'), ...new Array<Op>(m).fill('+')];
}

function backtrack(trace: Int32Array[], n: number, m: number): Op[] {
  const ops: Op[] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const v = trace[d];
    const at = (k: number) => v[k + d + 1];
    const k = x - y;
    const prevK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const prevX = d === 0 ? 0 : at(prevK);
    const prevY = d === 0 ? 0 : prevX - prevK;
    while (x > prevX && y > prevY) {
      ops.push('=');
      x--;
      y--;
    }
    if (d > 0) {
      ops.push(x === prevX ? '+' : '-');
    }
    x = prevX;
    y = prevY;
  }
  return ops.reverse();
}

// ─── Blocks ─────────────────────────────────────────────────────────────────

type Token = ReturnType<MarkdownIt['parse']>[number];

interface Block {
  start: number;
  end: number;
  /** For a table, its rows, which are diffed one by one. */
  rows?: Row[];
}

interface Row extends Block {
  /** Token indices of its `tr_open` and `tr_close`. */
  open: number;
  close: number;
}

/** Source line ranges of the top-level blocks. */
function topLevelBlocks(md: MarkdownIt, text: string, env: object): { blocks: Block[]; tokens: Token[] } {
  const tokens = md.parse(blankFrontMatter(text), env);
  const blocks: Block[] = [];
  tokens.forEach((t, i) => {
    if (t.level === 0 && t.nesting !== -1 && t.map) {
      const block: Block = { start: t.map[0], end: t.map[1] };
      if (t.type === 'table_open') {
        block.rows = tableRows(tokens, i, block.end);
      }
      blocks.push(block);
    }
  });
  return { blocks, tokens };
}

function tableRows(tokens: Token[], open: number, end: number): Row[] | undefined {
  const rows: Row[] = [];
  for (let i = open + 1; i < tokens.length && tokens[i].type !== 'table_close'; i++) {
    if (tokens[i].type !== 'tr_open') {
      continue;
    }
    const map = tokens[i].map;
    let close = i;
    while (tokens[close].type !== 'tr_close') {
      close++;
    }
    if (!map) {
      return undefined;
    }
    rows.push({ start: map[0], end: map[1], open: i, close });
    i = close;
  }
  // Each row runs to the next, so the header takes the delimiter line with it.
  rows.forEach((row, k) => (row.end = rows[k + 1]?.start ?? end));
  return rows;
}

const touches = (block: Block, lines: boolean[]) => lines.slice(block.start, block.end).some(Boolean);

const containing = <T extends Block>(blocks: T[], line: number): T | undefined =>
  blocks.find((b) => b.start <= line && line < b.end) ?? blocks.find((b) => b.start >= line);

/**
 * Which top-level blocks of `current` changed since `base`, and the rendered
 * `base` blocks that were removed or replaced, each placed before the block
 * of `current` it precedes. A table that is still there is diffed by row.
 */
export function blockDiff(md: MarkdownIt, base: string, current: string, env: RenderEnv = {}): DiffView {
  const diff = diffLines(splitLines(base), splitLines(current));
  const { blocks: newBlocks } = topLevelBlocks(md, current, {});
  const baseEnv: { references?: unknown } = {};
  const { blocks: oldBlocks, tokens: oldTokens } = topLevelBlocks(md, base, baseEnv);

  // An old table is the same table as the new one any of its unchanged lines moved into.
  const tableOf = new Map<Block, Block>();
  for (const old of oldBlocks) {
    for (let line = old.start; old.rows && line < old.end; line++) {
      const moved = diff.oldToNew[line];
      const table = diff.removed[line] ? undefined : newBlocks.find((b) => b.rows && b.start <= moved && moved < b.end);
      if (table) {
        tableOf.set(old, table);
        break;
      }
    }
  }
  const pairedTables = new Set(tableOf.values());

  // Consecutive removed blocks (or rows) that land at the same place render as one chunk.
  const groups: { before?: number; table?: number; first: Block; last: Block; index: number }[] = [];
  const remove = (block: Block, index: number, before: number | undefined, table?: number) => {
    const group = groups[groups.length - 1];
    if (group && group.index === index - 1 && group.before === before && group.table === table) {
      group.last = block;
      group.index = index;
    } else {
      groups.push({ before, table, first: block, last: block, index });
    }
  };
  let index = 0;
  for (const block of oldBlocks) {
    const table = tableOf.get(block);
    if (table) {
      for (const row of block.rows!) {
        if (touches(row, diff.removed)) {
          remove(row, index, containing(table.rows!, diff.oldToNew[row.start])?.start, table.start);
        }
        index++;
      }
    } else if (touches(block, diff.removed)) {
      remove(block, index, containing(newBlocks, diff.oldToNew[block.start] ?? 0)?.start);
    }
    index++;
  }

  const baseLines = splitLines(blankFrontMatter(base));
  // Reference definitions may live elsewhere in the old text.
  const renderEnv = { ...env, references: baseEnv.references };
  return {
    changed: newBlocks.filter((b) => !pairedTables.has(b) && touches(b, diff.added)).map((b) => b.start),
    changedRows: [...pairedTables].flatMap((t) => t.rows!.filter((r) => touches(r, diff.added)).map((r) => r.start)),
    removed: groups.map((g) => ({
      before: g.before,
      table: g.table,
      html:
        g.table === undefined
          ? md.render(baseLines.slice(g.first.start, g.last.end).join('\n'), renderEnv)
          : md.renderer.render(oldTokens.slice((g.first as Row).open, (g.last as Row).close + 1), md.options, renderEnv),
    })),
  };
}
