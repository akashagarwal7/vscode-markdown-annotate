/**
 * Line diff projected onto top-level Markdown blocks, for showing a rendered
 * diff against a git revision in the preview.
 */
import MarkdownIt = require('markdown-it');
import { blankFrontMatter, RenderEnv } from './markdown';
import { diffLines, splitLines } from './myers';
import type { DiffView } from '../protocol';

export { diffLines, splitLines } from './myers';

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
