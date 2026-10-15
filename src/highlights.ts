/**
 * The highlight model for a document: stored highlights plus the `<mark>`
 * highlights written into the file, and the operations that move between them.
 */
import * as vscode from 'vscode';
import MarkdownIt = require('markdown-it');
import { findQuote, QuoteMatch, TextQuote } from './core/anchor';
import { buildTextMap, createMarkdown, SourceRange, TextMap } from './core/markdown';
import {
  applyEdits,
  Edit,
  fileHighlights,
  groupPieces,
  insertEdits,
  linkEdits,
  newId,
  parseMarks,
  planMarks,
  removeEdits,
  retagEdits,
  sourceSpans,
} from './core/marks';
import { markStyle, palette, writeToFile } from './config';
import type { StoredHighlight } from './protocol';
import type { HighlightStore } from './store';

export interface ResolvedHighlight {
  id: string;
  color: string;
  note?: string;
  text: string;
  line: number;
  /** `file` highlights live in the Markdown source as `<mark>` tags. */
  source: 'store' | 'file';
  /** Stored highlight whose text no longer exists in the document. */
  orphaned: boolean;
  /** Highlighted source ranges (content only, not tags). */
  ranges: SourceRange[];
  /** Ranges of the `<mark>` tags themselves, for file highlights. */
  tagRanges: SourceRange[];
}

export class HighlightService {
  readonly md: MarkdownIt = createMarkdown();
  private cached?: { key: string; map: TextMap };

  constructor(readonly store: HighlightStore) {}

  textMap(doc: vscode.TextDocument): TextMap {
    const key = `${doc.uri.toString()}@${doc.version}`;
    if (this.cached?.key !== key) {
      this.cached = { key, map: buildTextMap(this.md, doc.getText()) };
    }
    return this.cached.map;
  }

  locate(map: TextMap, quote: TextQuote, line?: number): QuoteMatch | undefined {
    return findQuote(map.chars, quote, line === undefined ? undefined : (i) => Math.abs(map.segments[map.seg[i]].line - line));
  }

  /** All highlights of a document, in document order. */
  async resolve(doc: vscode.TextDocument): Promise<ResolvedHighlight[]> {
    const map = this.textMap(doc);
    const result: ResolvedHighlight[] = [];

    for (const fh of fileHighlights(map)) {
      result.push({
        id: fh.id,
        color: fh.color,
        note: fh.note,
        text: fh.quote.exact,
        line: fh.line,
        source: 'file',
        orphaned: false,
        ranges: fh.pieces.map((p) => ({ start: p.openEnd, end: p.closeStart })),
        tagRanges: fh.pieces.flatMap((p) => [
          { start: p.openStart, end: p.openEnd },
          { start: p.closeStart, end: p.closeEnd },
        ]),
      });
    }

    for (const h of await this.store.get(doc.uri)) {
      const match = this.locate(map, h.quote, h.line);
      const ranges = match ? sourceSpans(map, match) : [];
      result.push({
        id: h.id,
        color: h.color,
        note: h.note,
        text: h.quote.exact,
        line: ranges.length ? doc.positionAt(ranges[0].start).line : (h.line ?? 0),
        source: 'store',
        orphaned: !match,
        ranges,
        tagRanges: [],
      });
    }

    const pos = (h: ResolvedHighlight) => (h.ranges.length ? h.ranges[0].start : Number.MAX_SAFE_INTEGER);
    return result.sort((a, b) => pos(a) - pos(b) || a.line - b.line);
  }

  async create(doc: vscode.TextDocument, quote: TextQuote, line: number | undefined, color: string): Promise<void> {
    const highlight: StoredHighlight = { id: newId(), color, quote, line, createdAt: Date.now() };
    if (writeToFile(doc.uri)) {
      const map = this.textMap(doc);
      const match = this.locate(map, quote, line);
      const plan = match ? planMarks(map, match) : { ok: false as const, reason: 'the text could not be found in the source' };
      if (plan.ok) {
        await applyToDocument(doc, insertEdits(plan.ranges, highlight, markStyle(color)));
        return;
      }
      void vscode.window.showWarningMessage(
        `Markdown Annotate: couldn't write this highlight into the file (${plan.reason}); it was saved separately instead.`,
      );
    }
    await this.store.add(doc.uri, highlight);
  }

  /** Make the text at `quote` a link to `href`; returns why it couldn't be. */
  async link(doc: vscode.TextDocument, quote: TextQuote, line: number | undefined, href: string): Promise<string | undefined> {
    const map = this.textMap(doc);
    const match = this.locate(map, quote, line);
    const edits = match ? linkEdits(map, match, href) : 'the text could not be found in the source';
    if (typeof edits === 'string') {
      return edits;
    }
    await applyToDocument(doc, edits);
    return undefined;
  }

  async update(doc: vscode.TextDocument, id: string, patch: { color?: string; note?: string }): Promise<void> {
    const pieces = groupPieces(parseMarks(this.textMap(doc))).get(id);
    if (pieces) {
      const color = patch.color ?? pieces[0].color;
      const note = patch.note !== undefined ? patch.note : pieces.find((p) => p.note)?.note;
      await applyToDocument(doc, retagEdits(pieces, { id, color, note: note || undefined }, markStyle(color)));
      return;
    }
    const next: Partial<StoredHighlight> = {};
    if (patch.color !== undefined) {
      next.color = patch.color;
    }
    if (patch.note !== undefined) {
      next.note = patch.note || undefined;
    }
    await this.store.update(doc.uri, id, next);
  }

  async remove(doc: vscode.TextDocument, id: string): Promise<void> {
    const pieces = groupPieces(parseMarks(this.textMap(doc))).get(id);
    if (pieces) {
      await applyToDocument(doc, removeEdits(pieces));
      return;
    }
    await this.store.remove(doc.uri, id);
  }

  /** Write stored highlights into the file as `<mark>` tags. */
  async writeAllToFile(doc: vscode.TextDocument): Promise<{ written: number; skipped: number }> {
    const stored = await this.store.get(doc.uri);
    let text = doc.getText();
    const remaining: StoredHighlight[] = [];
    let written = 0;
    for (const h of stored) {
      const map = buildTextMap(this.md, text);
      const match = this.locate(map, h.quote, h.line);
      const plan = match ? planMarks(map, match) : undefined;
      if (plan?.ok) {
        text = applyEdits(text, insertEdits(plan.ranges, h, markStyle(h.color)));
        written++;
      } else {
        remaining.push(h);
      }
    }
    if (written) {
      await replaceDocument(doc, text);
      await this.store.set(doc.uri, remaining);
    }
    return { written, skipped: remaining.length };
  }

  /** Strip `<mark>` highlights out of the file, keeping them as stored highlights. */
  async moveAllOutOfFile(doc: vscode.TextDocument): Promise<number> {
    const map = this.textMap(doc);
    const found = fileHighlights(map).filter((fh) => fh.quote.exact);
    if (!found.length) {
      return 0;
    }
    const moved: StoredHighlight[] = found.map((fh) => ({
      id: fh.id,
      color: fh.color,
      note: fh.note,
      quote: fh.quote,
      line: fh.line,
      createdAt: Date.now(),
    }));
    await applyToDocument(doc, removeEdits(found.flatMap((fh) => fh.pieces)));
    await this.store.set(doc.uri, [...(await this.store.get(doc.uri)), ...moved]);
    return moved.length;
  }

  async clear(doc: vscode.TextDocument): Promise<void> {
    const pieces = parseMarks(this.textMap(doc));
    if (pieces.length) {
      await applyToDocument(doc, removeEdits(pieces));
    }
    await this.store.set(doc.uri, []);
  }

  /** A Markdown summary of the document's highlights, grouped by colour. */
  async exportMarkdown(doc: vscode.TextDocument): Promise<string> {
    const highlights = (await this.resolve(doc)).filter((h) => h.text);
    const name = vscode.workspace.asRelativePath(doc.uri);
    const lines = [`# Highlights — ${name}`, ''];
    const order = palette().map((c) => c.name);
    const colors = [...new Set(highlights.map((h) => h.color))].sort(
      (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99),
    );
    for (const color of colors) {
      lines.push(`## ${color[0].toUpperCase()}${color.slice(1)}`, '');
      for (const h of highlights.filter((x) => x.color === color)) {
        lines.push(...h.text.split('\n').map((l) => `> ${l}`));
        lines.push('>', `> — line ${h.line + 1}${h.note ? ` · ${h.note}` : ''}${h.orphaned ? ' · _text no longer in document_' : ''}`, '');
      }
    }
    if (!highlights.length) {
      lines.push('_No highlights._', '');
    }
    return lines.join('\n');
  }
}

async function applyToDocument(doc: vscode.TextDocument, edits: Edit[]): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  for (const e of edits) {
    edit.replace(doc.uri, new vscode.Range(doc.positionAt(e.offset), doc.positionAt(e.offset + e.length)), e.text);
  }
  await vscode.workspace.applyEdit(edit);
}

async function replaceDocument(doc: vscode.TextDocument, text: string): Promise<void> {
  const edit = new vscode.WorkspaceEdit();
  edit.replace(doc.uri, new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text);
  await vscode.workspace.applyEdit(edit);
}
