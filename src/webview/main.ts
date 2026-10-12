/**
 * Preview webview: renders the document HTML, paints highlights, and turns
 * text selections into highlight requests for the extension.
 */
import { findQuote, quoteFromRange, strip, TextQuote } from '../core/anchor';
import { Range, wordDiff } from '../core/words';
import type { FromWebview, PaletteColor, PreviewTheme, RenderMessage, StoredHighlight, ToWebview, WebviewState } from '../protocol';

interface VsCodeApi {
  postMessage(message: FromWebview): void;
  getState(): WebviewState | undefined;
  setState(state: WebviewState): void;
}
declare function acquireVsCodeApi(): VsCodeApi;
declare global {
  interface Window {
    __ANNOTATE_STATE__: WebviewState;
  }
}

const vscode = acquireVsCodeApi();
const initialState = window.__ANNOTATE_STATE__;
// The git diff view is on unless turned off in this preview.
let viewState: WebviewState = { diff: true, ...vscode.getState(), uri: initialState.uri };
vscode.setState(viewState);

const post = (message: FromWebview) => vscode.postMessage(message);
const content = document.getElementById('content') as HTMLElement;

let current: RenderMessage | undefined;
let firstRender = true;
let pending: { quote: TextQuote; line?: number } | undefined;
let unanchored = 0;

// ─── Chrome: header, selection toolbar, popover ─────────────────────────────

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) {
    node.className = className;
  }
  if (text) {
    node.textContent = text;
  }
  return node;
}

const paletteStyle = el('style');
document.head.appendChild(paletteStyle);

const header = el('header', 'ma-bar');
const titleEl = el('span', 'ma-title');
const countEl = el('span', 'ma-count');
const toggleLabel = el('label', 'ma-toggle');
const toggle = el('input');
toggle.type = 'checkbox';
toggle.addEventListener('change', () => post({ type: 'setWriteToFile', value: toggle.checked }));
toggleLabel.append(toggle, document.createTextNode(' Write highlights into file'));
toggleLabel.title = 'When on, new highlights are written into the Markdown source as <mark> tags';

// Theme: follow VS Code, or force light/dark for reading.
const themes: { value: PreviewTheme; label: string; title: string }[] = [
  { value: 'auto', label: 'Auto', title: 'Follow the VS Code colour theme' },
  { value: 'light', label: 'Light', title: 'Always use a light preview' },
  { value: 'dark', label: 'Dark', title: 'Always use a dark preview' },
];
const themeSwitch = el('div', 'ma-theme');
themeSwitch.setAttribute('role', 'radiogroup');
themeSwitch.setAttribute('aria-label', 'Preview theme');
let theme: PreviewTheme = 'auto';
for (const t of themes) {
  const button = el('button', undefined, t.label);
  button.type = 'button';
  button.dataset.theme = t.value;
  button.title = t.title;
  button.setAttribute('role', 'radio');
  button.addEventListener('click', () => {
    applyTheme(t.value);
    post({ type: 'setTheme', value: t.value });
  });
  themeSwitch.appendChild(button);
}

/** VS Code marks the body with its theme kind; a forced theme overrides it. */
function vscodeIsDark(): boolean {
  const c = document.body.classList;
  return c.contains('vscode-dark') || (c.contains('vscode-high-contrast') && !c.contains('vscode-high-contrast-light'));
}

function applyTheme(next: PreviewTheme): void {
  theme = next;
  if (next === 'auto') {
    delete document.body.dataset.theme;
  } else {
    document.body.dataset.theme = next;
  }
  const dark = next === 'dark' || (next === 'auto' && vscodeIsDark());
  document.body.dataset.effectiveTheme = dark ? 'dark' : 'light';
  for (const b of themeSwitch.querySelectorAll<HTMLButtonElement>('button')) {
    b.setAttribute('aria-checked', String(b.dataset.theme === next));
  }
}

// Follow live VS Code theme changes while in auto mode.
new MutationObserver(() => applyTheme(theme)).observe(document.body, { attributes: true, attributeFilter: ['class'] });
applyTheme('auto');

// Git diff: show what changed since the last commit.
const DIFF_TITLE = 'Show changes since the last commit (HEAD)';
const diffButton = el('button', 'ma-diff-toggle', 'Git diff');
diffButton.type = 'button';
diffButton.title = DIFF_TITLE;
diffButton.setAttribute('aria-pressed', String(!!viewState.diff));
diffButton.addEventListener('click', () => {
  const value = !viewState.diff;
  viewState = { ...viewState, diff: value };
  vscode.setState(viewState);
  diffButton.setAttribute('aria-pressed', String(value));
  post({ type: 'setDiff', value });
});

header.append(titleEl, countEl, el('span', 'ma-spacer'), diffButton, themeSwitch, toggleLabel);
document.body.prepend(header);

const toolbar = el('div', 'ma-toolbar');
toolbar.setAttribute('role', 'toolbar');
toolbar.setAttribute('aria-label', 'Highlight colour');
toolbar.hidden = true;
document.body.appendChild(toolbar);

const popover = el('div', 'ma-popover');
popover.hidden = true;
document.body.appendChild(popover);
let popoverId: string | undefined;

function swatch(color: PaletteColor, index: number, pressed: boolean, onPick: () => void): HTMLButtonElement {
  const button = el('button', 'ma-swatch');
  button.type = 'button';
  button.dataset.color = color.name;
  button.title = `${capitalise(color.name)} (${index + 1})`;
  button.setAttribute('aria-label', `${capitalise(color.name)} highlight`);
  button.setAttribute('aria-pressed', String(pressed));
  // Keep the text selection alive while clicking.
  button.addEventListener('mousedown', (e) => e.preventDefault());
  button.addEventListener('click', onPick);
  return button;
}

function capitalise(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function buildToolbar(palette: PaletteColor[]): void {
  toolbar.replaceChildren(...palette.map((c, i) => swatch(c, i, false, () => createHighlight(c.name))));
}

function updatePalette(palette: PaletteColor[]): void {
  paletteStyle.textContent = palette
    .map((c) => `[data-color="${c.name}"] { --hl: ${c.color}; }`)
    .join('\n');
  buildToolbar(palette);
}

function updateHeader(): void {
  if (!current) {
    return;
  }
  titleEl.textContent = current.title;
  const total = new Set([...content.querySelectorAll<HTMLElement>('.ma-hl')].map((e) => e.dataset.id)).size;
  let count = total === 1 ? '1 highlight' : `${total} highlights`;
  if (unanchored) {
    count += ` · ${unanchored} not found`;
  }
  const diff = current.diff;
  if (diff && 'view' in diff && !diff.view.changed.length && !diff.view.changedRows.length && !diff.view.removed.length) {
    count += ` · No changes since ${diff.base}`;
  }
  // On by default, so a file outside git shouldn't nag: explain on the button instead.
  const unavailable = diff && 'unavailable' in diff ? diff.unavailable : undefined;
  diffButton.classList.toggle('ma-unavailable', !!unavailable);
  diffButton.title = unavailable ? `${DIFF_TITLE}: ${unavailable}` : DIFF_TITLE;
  countEl.textContent = count;
  countEl.title = unanchored ? 'Some highlights no longer match the document text' : '';
  toggle.checked = current.writeToFile;
  if (current.theme !== theme) {
    applyTheme(current.theme);
  }
}

// ─── Rendering highlights ───────────────────────────────────────────────────

interface TextIndex {
  text: string;
  nodes: Text[];
  starts: number[];
}

/** Text nodes of the document; removed diff blocks are not part of it. */
function textWalker(): TreeWalker {
  return document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.ma-diff-del') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
}

function textIndex(): TextIndex {
  const walker = textWalker();
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = '';
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    nodes.push(n as Text);
    starts.push(text.length);
    text += (n as Text).data;
  }
  return { text, nodes, starts };
}

function nodeAt(index: TextIndex, offset: number): Text | undefined {
  let lo = 0;
  let hi = index.starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (index.starts[mid] <= offset) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return index.nodes[lo];
}

function lineOf(node: Node | null | undefined): number | undefined {
  const element = node instanceof Element ? node : node?.parentElement;
  const block = element?.closest<HTMLElement>('[data-line]');
  return block ? Number(block.dataset.line) : undefined;
}

// Whitespace between block elements must not be wrapped in spans.
const BLOCK_CONTAINERS = new Set(['MAIN', 'UL', 'OL', 'TABLE', 'THEAD', 'TBODY', 'TFOOT', 'TR', 'BLOCKQUOTE', 'DIV', 'SECTION', 'DL']);

function wrap(start: number, end: number, h: { id: string; color: string; note?: string }): void {
  const walker = textWalker();
  const targets: { node: Text; a: number; b: number }[] = [];
  let pos = 0;
  for (let n = walker.nextNode() as Text | null; n && pos < end; n = walker.nextNode() as Text | null) {
    const len = n.data.length;
    const a = Math.max(start, pos);
    const b = Math.min(end, pos + len);
    if (a < b) {
      targets.push({ node: n, a: a - pos, b: b - pos });
    }
    pos += len;
  }
  for (const { node, a, b } of targets) {
    const slice = node.data.slice(a, b);
    if (!slice.trim() && BLOCK_CONTAINERS.has(node.parentElement?.tagName ?? '')) {
      continue;
    }
    let target = node;
    if (b < node.data.length) {
      target.splitText(b);
    }
    if (a > 0) {
      target = target.splitText(a);
    }
    const span = el('span', 'ma-hl');
    span.dataset.id = h.id;
    span.dataset.color = h.color;
    if (h.note) {
      span.title = h.note;
    }
    target.parentNode!.replaceChild(span, target);
    span.appendChild(target);
  }
}

function decorateFileMarks(): void {
  for (const mark of content.querySelectorAll<HTMLElement>('mark[data-hl]')) {
    mark.classList.add('ma-hl', 'ma-file');
    mark.dataset.id = mark.dataset.hlId || '';
    mark.dataset.color = mark.dataset.hl || '';
  }
}

function paintStored(highlights: StoredHighlight[]): void {
  const index = textIndex();
  const stripped = strip(index.text);
  const matches: { start: number; end: number; h: StoredHighlight }[] = [];
  unanchored = 0;
  for (const h of [...highlights].sort((a, b) => a.createdAt - b.createdAt)) {
    const lineDistance =
      h.line === undefined
        ? undefined
        : (i: number) => Math.abs((lineOf(nodeAt(index, stripped.index[i])) ?? h.line!) - h.line!);
    const m = findQuote(stripped.chars, h.quote, lineDistance);
    if (!m) {
      unanchored++;
      continue;
    }
    matches.push({ start: stripped.index[m.start], end: stripped.index[m.end - 1] + 1, h });
  }
  // Wrapping splits text nodes but never changes the text, so offsets stay valid.
  for (const { start, end, h } of matches) {
    wrap(start, end, h);
  }
}

// ─── Diff against git ───────────────────────────────────────────────────────

/** Source line of a top-level block (fences carry it on their inner <code>). */
function blockLine(block: Element): number | undefined {
  const line = (block as HTMLElement).dataset.line ?? block.querySelector<HTMLElement>('[data-line]')?.dataset.line;
  return line === undefined ? undefined : Number(line);
}

/** Mark changed blocks and insert the removed ones. Runs after highlights are painted. */
function applyDiff(diff: RenderMessage['diff']): void {
  document.body.classList.toggle('ma-diffing', !!diff);
  diffButton.setAttribute('aria-pressed', String(!!diff));
  if (!diff || 'unavailable' in diff) {
    return;
  }
  const blocks: { el: Element; line: number }[] = [];
  for (const child of content.children) {
    const line = blockLine(child);
    if (line !== undefined) {
      blocks.push({ el: child, line });
    }
  }
  const changed = new Set(diff.view.changed);
  for (const b of blocks) {
    if (changed.has(b.line)) {
      b.el.classList.add('ma-diff-add');
    }
  }
  const rowOf = (table: Element | undefined, line: number) =>
    table?.querySelector(`:scope > * > tr[data-line="${line}"]`) ?? undefined;
  for (const line of diff.view.changedRows) {
    for (const b of blocks) {
      rowOf(b.el.tagName === 'TABLE' ? b.el : undefined, line)?.classList.add('ma-diff-add');
    }
  }
  for (const removed of diff.view.removed) {
    if (removed.table !== undefined) {
      const table = blocks.find((b) => b.line === removed.table && b.el.tagName === 'TABLE')?.el;
      if (table) {
        const next = rowOf(table, removed.before ?? -1);
        markWords(insertRows(table, next, removed.html, diff.base), next);
      }
      continue;
    }
    const chunk = el('div', 'ma-diff-del');
    chunk.title = `Removed since ${diff.base}`;
    chunk.innerHTML = removed.html;
    clearSourceAttributes(chunk);
    const next = removed.before === undefined ? undefined : blocks.find((b) => b.line >= removed.before!);
    content.insertBefore(chunk, next?.el ?? null);
    markWords([...chunk.children], next?.el);
  }
}

/**
 * Pair removed blocks (or rows) with the changed ones that follow them, in
 * order, and mark the words that differ within each pair.
 */
function markWords(removed: Element[], next: Element | undefined): void {
  for (const old of removed) {
    if (!next?.classList.contains('ma-diff-add')) {
      return;
    }
    const words = wordDiff(old.textContent ?? '', next.textContent ?? '');
    if (words) {
      wrapRanges(old, words.removed, 'ma-diff-word');
      wrapRanges(next, words.added, 'ma-diff-word');
    }
    next = next.nextElementSibling ?? undefined;
  }
}

/** Wrap character ranges of `root`'s text (as in `textContent`) in spans. */
function wrapRanges(root: Element, ranges: Range[], className: string): void {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const targets: { node: Text; a: number; b: number }[] = [];
  let pos = 0;
  let r = 0;
  for (let n = walker.nextNode() as Text | null; n && r < ranges.length; n = walker.nextNode() as Text | null) {
    const end = pos + n.data.length;
    for (let k = r; k < ranges.length && ranges[k][0] < end; k++) {
      const a = Math.max(ranges[k][0], pos);
      const b = Math.min(ranges[k][1], end);
      if (a < b) {
        targets.push({ node: n, a: a - pos, b: b - pos });
      }
    }
    while (r < ranges.length && ranges[r][1] <= end) {
      r++;
    }
    pos = end;
  }
  // Back to front, so splitting a node leaves the earlier offsets in it valid.
  for (const { node, a, b } of targets.reverse()) {
    if (!node.data.slice(a, b).trim() && BLOCK_CONTAINERS.has(node.parentElement?.tagName ?? '')) {
      continue;
    }
    const piece = node.splitText(a);
    piece.splitText(b - a);
    const span = el('span', className);
    piece.replaceWith(span);
    span.append(piece);
  }
}

/** Old line numbers and heading ids would confuse scroll sync and links. */
function clearSourceAttributes(root: Element): void {
  for (const node of root.querySelectorAll('[data-line], [id]')) {
    node.removeAttribute('data-line');
    node.removeAttribute('id');
  }
}

/** Insert removed table rows before `next`, or at the end of the table's body. */
function insertRows(table: Element, next: Element | undefined, html: string, base: string): Element[] {
  const rows = document.createElement('tbody');
  rows.innerHTML = html;
  clearSourceAttributes(rows);
  let parent: Element | null | undefined = next?.parentElement;
  if (!parent) {
    parent = table.querySelector(':scope > tbody:last-of-type');
    if (!parent) {
      parent = table.appendChild(document.createElement('tbody'));
    }
  }
  const inserted = [...rows.children];
  for (const row of inserted) {
    row.classList.add('ma-diff-del');
    (row as HTMLElement).title = `Removed since ${base}`;
    parent.insertBefore(row, next ?? null);
  }
  return inserted;
}

// ─── Scrollbar ──────────────────────────────────────────────────────────────

// The page draws its own scrollbar, like VS Code's editor, so diff changes and
// highlights can be marked on it (an overview ruler). Native scrollbars can't be
// painted reliably across VS Code/Cursor versions.
const ruler = el('div', 'ma-ruler');
ruler.setAttribute('aria-hidden', 'true');
const rulerMarks = el('div', 'ma-ruler-marks');
const thumb = el('div', 'ma-ruler-thumb');
ruler.append(rulerMarks, thumb);
document.body.appendChild(ruler);

let rulerFrame = 0;
let thumbFrame = 0;

function scheduleRuler(): void {
  cancelAnimationFrame(rulerFrame);
  rulerFrame = requestAnimationFrame(() => {
    updateMarks();
    updateThumb();
  });
}

function scheduleThumb(): void {
  cancelAnimationFrame(thumbFrame);
  thumbFrame = requestAnimationFrame(updateThumb);
}

/** Thumb height and travel, in px. */
function thumbMetrics(): { height: number; travel: number; scrollable: number } {
  const view = window.innerHeight;
  const total = document.documentElement.scrollHeight;
  const height = Math.max(20, Math.round((view / total) * view));
  return { height, travel: view - height, scrollable: total - view };
}

function updateThumb(): void {
  const { height, travel, scrollable } = thumbMetrics();
  ruler.hidden = scrollable <= 0;
  thumb.style.height = `${height}px`;
  thumb.style.transform = `translateY(${scrollable > 0 ? (window.scrollY / scrollable) * travel : 0}px)`;
}

interface RulerMark {
  top: number;
  bottom: number;
  className: string;
  color?: string;
}

function updateMarks(): void {
  const diff: RulerMark[] = [];
  for (const block of content.querySelectorAll<HTMLElement>(
    ':scope > :is(.ma-diff-add, .ma-diff-del), :scope > table > * > tr:is(.ma-diff-add, .ma-diff-del)',
  )) {
    const rect = block.getBoundingClientRect();
    diff.push({ top: rect.top, bottom: rect.bottom, className: block.classList.contains('ma-diff-add') ? 'ma-add' : 'ma-del' });
  }

  // One mark per highlight, spanning all of its pieces.
  const byId = new Map<string, RulerMark>();
  for (const span of content.querySelectorAll<HTMLElement>('.ma-hl')) {
    const rect = span.getBoundingClientRect();
    const id = span.dataset.id ?? '';
    const mark = byId.get(id);
    if (mark) {
      mark.top = Math.min(mark.top, rect.top);
      mark.bottom = Math.max(mark.bottom, rect.bottom);
    } else {
      // Highlights with a note (kept in `title`) are marked distinctly.
      const className = span.title ? 'ma-hl-mark ma-noted' : 'ma-hl-mark';
      byId.set(id, { top: rect.top, bottom: rect.bottom, className, color: span.dataset.color });
    }
  }

  // Like the editor's overview ruler: git changes on the left, highlights on the right.
  const lanes = diff.length && byId.size;
  const scale = window.innerHeight / document.documentElement.scrollHeight;
  const nodes: HTMLElement[] = [];
  for (const [marks, lane] of [
    [diff, 'ma-left'],
    [[...byId.values()], 'ma-right'],
  ] as const) {
    for (const mark of marks) {
      const node = el('div', `ma-ruler-mark ${mark.className}${lanes ? ` ${lane}` : ''}`);
      const top = Math.round((mark.top + window.scrollY) * scale);
      node.style.top = `${top}px`;
      // Keep small marks visible.
      const min = mark.className.includes('ma-noted') ? 6 : 3;
      node.style.height = `${Math.max(min, Math.round((mark.bottom + window.scrollY) * scale) - top)}px`;
      if (mark.color) {
        node.dataset.color = mark.color;
      }
      nodes.push(node);
    }
  }
  rulerMarks.replaceChildren(...nodes);
}

// Drag the thumb, or click the track to jump there.
ruler.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) {
    return;
  }
  e.preventDefault();
  e.stopPropagation();
  const { height, travel, scrollable } = thumbMetrics();
  if (e.target !== thumb) {
    const y = e.clientY - height / 2;
    window.scrollTo({ top: (Math.max(0, Math.min(y, travel)) / travel) * scrollable });
  }
  const startY = e.clientY;
  const startScroll = window.scrollY;
  ruler.setPointerCapture(e.pointerId);
  ruler.classList.add('ma-dragging');
  const move = (m: PointerEvent) => window.scrollTo({ top: startScroll + ((m.clientY - startY) / travel) * scrollable });
  const end = () => {
    ruler.classList.remove('ma-dragging');
    ruler.removeEventListener('pointermove', move);
    ruler.removeEventListener('pointerup', end);
    ruler.removeEventListener('pointercancel', end);
  };
  ruler.addEventListener('pointermove', move);
  ruler.addEventListener('pointerup', end);
  ruler.addEventListener('pointercancel', end);
});

window.addEventListener('scroll', scheduleThumb, { passive: true });
window.addEventListener('resize', scheduleRuler);
// Images and fonts loading change block positions.
new ResizeObserver(scheduleRuler).observe(content);

function render(message: RenderMessage): void {
  current = message;
  updatePalette(message.palette);
  content.innerHTML = message.html;
  decorateFileMarks();
  paintStored(message.highlights);
  applyDiff(message.diff);
  scheduleRuler();
  updateHeader();
  if (firstRender) {
    firstRender = false;
    if (viewState.scrollY) {
      window.scrollTo(0, viewState.scrollY);
    }
  }
  if (popoverId) {
    const anchor = firstHighlight(popoverId);
    if (anchor && popover.contains(document.activeElement)) {
      // Don't rebuild while the note is being typed.
      positionPopover(anchor);
    } else if (anchor) {
      showPopover(popoverId, anchor, false);
    } else {
      hidePopover();
    }
  }
}

function firstHighlight(id: string): HTMLElement | null {
  return content.querySelector<HTMLElement>(`.ma-hl[data-id="${CSS.escape(id)}"]`);
}

// ─── Selection → new highlight ──────────────────────────────────────────────

/** Offset of a DOM position in the text of `textIndex()`. */
function offsetOf(container: Node, offset: number): number {
  const point = document.createRange();
  point.setStart(container, offset);
  const walker = textWalker();
  let total = 0;
  for (let n = walker.nextNode() as Text | null; n; n = walker.nextNode() as Text | null) {
    if (n === container) {
      return total + offset;
    }
    if (point.comparePoint(n, n.length) > 0) {
      break;
    }
    total += n.length;
  }
  return total;
}

function onSelectionChange(): void {
  const selection = document.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) {
    hideToolbar();
    return;
  }
  const range = selection.getRangeAt(0);
  if (!content.contains(range.commonAncestorContainer)) {
    hideToolbar();
    return;
  }
  const text = textIndex().text;
  const quote = quoteFromRange(text, offsetOf(range.startContainer, range.startOffset), offsetOf(range.endContainer, range.endOffset));
  if (!quote) {
    hideToolbar();
    return;
  }
  pending = { quote, line: lineOf(range.startContainer) };
  hidePopover();
  showToolbar(range.getBoundingClientRect());
}

function showToolbar(rect: DOMRect): void {
  toolbar.hidden = false;
  const barBottom = header.getBoundingClientRect().bottom;
  const height = toolbar.offsetHeight;
  let top = rect.top - height - 8;
  if (top < barBottom + 4) {
    top = rect.bottom + 8;
  }
  const left = clamp(rect.left + rect.width / 2 - toolbar.offsetWidth / 2, 8, window.innerWidth - toolbar.offsetWidth - 8);
  toolbar.style.top = `${top + window.scrollY}px`;
  toolbar.style.left = `${left + window.scrollX}px`;
}

function hideToolbar(): void {
  toolbar.hidden = true;
  pending = undefined;
}

function createHighlight(color: string): void {
  if (!pending) {
    return;
  }
  post({ type: 'create', quote: pending.quote, line: pending.line, color });
  document.getSelection()?.removeAllRanges();
  hideToolbar();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

// ─── Popover for an existing highlight ──────────────────────────────────────

function showPopover(id: string, anchor: HTMLElement, focusNote: boolean): void {
  if (!current) {
    return;
  }
  const color = anchor.dataset.color ?? '';
  const note = anchor.title || '';
  const isFile = anchor.classList.contains('ma-file');
  popoverId = id;

  const swatches = el('div', 'ma-swatches');
  swatches.append(
    ...current.palette.map((c, i) => swatch(c, i, c.name === color, () => post({ type: 'update', id, color: c.name }))),
  );

  const textarea = el('textarea', 'ma-note');
  textarea.placeholder = 'Add a note…';
  textarea.rows = 2;
  textarea.value = note;
  let saved = note;
  const saveNote = () => {
    const value = textarea.value.trim();
    if (value !== saved) {
      saved = value;
      post({ type: 'update', id, note: value });
    }
  };
  textarea.addEventListener('blur', saveNote);
  textarea.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      saveNote();
      hidePopover();
    }
  });

  const actions = el('div', 'ma-actions');
  const where = el('span', 'ma-where', isFile ? 'In file' : 'Stored');
  where.title = isFile ? 'Saved in the Markdown file as a <mark> tag' : 'Saved alongside the file (not in it)';
  const source = el('button', 'ma-link', 'Show in source');
  source.type = 'button';
  source.addEventListener('click', () => {
    const line = lineOf(anchor);
    if (line !== undefined) {
      post({ type: 'revealLine', line });
    }
  });
  const remove = el('button', 'ma-danger', 'Delete');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    post({ type: 'delete', id });
    hidePopover();
  });
  actions.append(where, el('span', 'ma-spacer'), source, remove);

  popover.replaceChildren(swatches, textarea, actions);
  popover.hidden = false;
  positionPopover(anchor);
  if (focusNote) {
    textarea.focus();
  }
}

function positionPopover(anchor: HTMLElement): void {
  const rect = anchor.getBoundingClientRect();
  const left = clamp(rect.left, 8, window.innerWidth - popover.offsetWidth - 8);
  let top = rect.bottom + 6;
  if (top + popover.offsetHeight > window.innerHeight - 8) {
    top = rect.top - popover.offsetHeight - 6;
  }
  popover.style.top = `${top + window.scrollY}px`;
  popover.style.left = `${left + window.scrollX}px`;
}

function hidePopover(): void {
  if (!popover.hidden) {
    // Blur first so a half-typed note is saved.
    (document.activeElement as HTMLElement | null)?.blur?.();
  }
  popover.hidden = true;
  popoverId = undefined;
}

// ─── Events ─────────────────────────────────────────────────────────────────

document.addEventListener('mouseup', (e) => {
  if (toolbar.contains(e.target as Node) || popover.contains(e.target as Node)) {
    return;
  }
  setTimeout(onSelectionChange, 0);
});

document.addEventListener('keyup', (e) => {
  if (e.shiftKey || e.key === 'Shift' || ((e.metaKey || e.ctrlKey) && e.key === 'a')) {
    onSelectionChange();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideToolbar();
    hidePopover();
    return;
  }
  if (!toolbar.hidden && pending && current && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const color = current.palette[Number(e.key) - 1];
    if (color) {
      e.preventDefault();
      createHighlight(color.name);
    }
  }
});

document.addEventListener('mousedown', (e) => {
  const target = e.target as Node;
  if (!popover.hidden && !popover.contains(target)) {
    hidePopover();
  }
});

content.addEventListener('click', (e) => {
  const target = e.target as HTMLElement;
  const link = target.closest('a');
  if ((e.metaKey || e.ctrlKey) && !link) {
    const line = lineOf(target);
    if (line !== undefined) {
      post({ type: 'revealLine', line });
    }
    return;
  }
  if (link) {
    e.preventDefault();
    const href = link.getAttribute('href') ?? '';
    if (href.startsWith('#')) {
      document.getElementById(decodeURIComponent(href.slice(1)))?.scrollIntoView({ block: 'start' });
    } else if (href) {
      post({ type: 'openLink', href });
    }
    return;
  }
  const hl = target.closest<HTMLElement>('.ma-hl');
  if (hl && document.getSelection()?.isCollapsed !== false && hl.dataset.id) {
    showPopover(hl.dataset.id, hl, false);
  }
});

let scrollTimer: ReturnType<typeof setTimeout> | undefined;
window.addEventListener('scroll', () => {
  clearTimeout(scrollTimer);
  scrollTimer = setTimeout(() => {
    viewState = { ...viewState, scrollY: window.scrollY };
    vscode.setState(viewState);
  }, 100);
});

function scrollToLine(line: number): void {
  let best: HTMLElement | undefined;
  for (const block of content.querySelectorAll<HTMLElement>('[data-line]')) {
    if (Number(block.dataset.line) <= line) {
      best = block;
    } else {
      break;
    }
  }
  const offset = header.offsetHeight + 8;
  window.scrollTo({ top: best ? best.getBoundingClientRect().top + window.scrollY - offset : 0 });
}

function focusHighlight(id: string): void {
  const spans = content.querySelectorAll<HTMLElement>(`.ma-hl[data-id="${CSS.escape(id)}"]`);
  if (!spans.length) {
    return;
  }
  spans[0].scrollIntoView({ block: 'center' });
  for (const s of spans) {
    s.classList.remove('ma-flash');
    void s.offsetWidth;
    s.classList.add('ma-flash');
  }
}

window.addEventListener('message', (event: MessageEvent<ToWebview>) => {
  const message = event.data;
  switch (message.type) {
    case 'render':
      render(message);
      break;
    case 'scrollToLine':
      scrollToLine(message.line);
      break;
    case 'focusHighlight':
      focusHighlight(message.id);
      break;
  }
});

post({ type: 'ready', diff: viewState.diff });
