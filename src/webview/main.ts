/**
 * Preview webview: renders the document HTML, paints highlights, and turns
 * text selections into highlight requests for the extension.
 */
import { findQuote, quoteFromRange, strip, TextQuote } from '../core/anchor';
import { Range, wordDiff } from '../core/words';
// VS Code's `list-ordered` codicon (CC BY 4.0, see ThirdPartyNotices.txt).
import listOrderedSvg from './icons/list-ordered.svg';
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
let viewState: WebviewState = { diff: true, ...initialState, ...vscode.getState(), uri: initialState.uri };
vscode.setState(viewState);

const post = (message: FromWebview) => vscode.postMessage(message);
const content = document.getElementById('content') as HTMLElement;

let current: RenderMessage | undefined;
let firstRender = true;
/**
 * A selection to highlight or link; `uri` is set when it is in a link preview
 * of another file. `range` is kept to show it while the link box has the focus.
 */
let pending: { quote: TextQuote; line?: number; uri?: string; range: globalThis.Range } | undefined;
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

const syncLabel = el('label', 'ma-toggle');
const syncToggle = el('input');
syncToggle.type = 'checkbox';
syncToggle.addEventListener('change', () => {
  // Per preview, so it is kept with the preview's state.
  viewState = { ...viewState, scrollSync: syncToggle.checked };
  vscode.setState(viewState);
  post({ type: 'setScrollSync', value: syncToggle.checked });
});
syncLabel.append(syncToggle, document.createTextNode(' Sync scroll'));
syncLabel.title = 'Keep this preview and the editor scrolled to the same place, in both directions';

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
const diffButton = el('button', 'ma-toggle-button ma-diff-toggle', 'Git diff');
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

// Heading numbers: 1, 1.1, 1.2.1 … in the document and the table of contents.
const numberButton = el('button', 'ma-toggle-button ma-icon-button');
numberButton.append(icon(listOrderedSvg));
numberButton.type = 'button';
numberButton.title = 'Number headings';
numberButton.setAttribute('aria-label', 'Number headings');
numberButton.setAttribute('aria-pressed', 'false');
numberButton.addEventListener('click', () => {
  const value = numberButton.getAttribute('aria-pressed') !== 'true';
  applyNumbering(value);
  post({ type: 'setNumberHeadings', value });
});

/** An SVG icon file, drawn in the text colour (the icons use `currentColor`). */
function icon(markup: string): SVGSVGElement {
  const holder = el('span');
  holder.innerHTML = markup;
  const svg = holder.querySelector('svg')!;
  svg.setAttribute('aria-hidden', 'true');
  return svg;
}

// Back and forward through jumps within the preview, like a browser.
const nav = el('div', 'ma-nav');
const backButton = el('button', undefined, '←');
const forwardButton = el('button', undefined, '→');
const MOD = /Mac/.test(navigator.platform) ? '⌘' : 'Ctrl+';
backButton.title = `Back (${MOD}[ or Alt+←)`;
forwardButton.title = `Forward (${MOD}] or Alt+→)`;
for (const [button, label] of [
  [backButton, 'Back'],
  [forwardButton, 'Forward'],
] as const) {
  button.type = 'button';
  button.disabled = true;
  button.setAttribute('aria-label', label);
  nav.append(button);
}
backButton.addEventListener('click', () => goBack());

// Table of contents: the document's headings, in a floating list.
const tocButton = el('button', 'ma-toc-toggle', '☰');
tocButton.type = 'button';
tocButton.title = 'Table of contents';
tocButton.setAttribute('aria-label', 'Table of contents');
tocButton.setAttribute('aria-expanded', 'false');
tocButton.setAttribute('aria-controls', 'ma-toc');
nav.prepend(tocButton);
forwardButton.addEventListener('click', () => goForward());

header.append(nav, titleEl, countEl, el('span', 'ma-spacer'), numberButton, diffButton, themeSwitch, syncLabel, toggleLabel);
document.body.prepend(header);

const toolbar = el('div', 'ma-toolbar');
toolbar.setAttribute('role', 'toolbar');
toolbar.setAttribute('aria-label', 'Highlight or link the selection');
toolbar.hidden = true;
const swatchRow = el('div', 'ma-swatches');
// Make the selection a link: a box with completions, and a button.
const linkForm = el('form', 'ma-link-form');
const linkInput = el('input', 'ma-link-input');
linkInput.type = 'text';
linkInput.placeholder = 'Link to a file, or # a section';
linkInput.setAttribute('aria-label', 'Link to');
linkInput.setAttribute('role', 'combobox');
linkInput.setAttribute('aria-autocomplete', 'list');
linkInput.setAttribute('aria-controls', 'ma-link-options');
linkInput.setAttribute('aria-expanded', 'false');
linkInput.spellcheck = false;
linkInput.autocomplete = 'off';
const linkButton = el('button', 'ma-link-button', 'Link');
linkButton.type = 'submit';
const linkOptions = el('div', 'ma-link-options');
linkOptions.id = 'ma-link-options';
linkOptions.setAttribute('role', 'listbox');
linkOptions.hidden = true;
linkForm.append(linkInput, linkButton, linkOptions);
toolbar.append(swatchRow, linkForm);
document.body.appendChild(toolbar);

const popover = el('div', 'ma-popover');
popover.hidden = true;
document.body.appendChild(popover);
let popoverId: string | undefined;
/** The file of the popover's highlight, when it is in a link preview. */
let popoverUri: string | undefined;

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
  swatchRow.replaceChildren(...palette.map((c, i) => swatch(c, i, false, () => createHighlight(c.name))));
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
  syncToggle.checked = current.scrollSync;
  if (current.theme !== theme) {
    applyTheme(current.theme);
  }
}

/**
 * Number the headings by nesting, skipped levels collapsed (an h4 under an h2
 * is 1.1). A lone top heading opening the document is its title and isn't
 * numbered. Numbers are drawn by CSS, so they're not part of the text that
 * highlights are found in.
 */
function applyNumbering(on: boolean): void {
  numbering = on;
  numberButton.setAttribute('aria-pressed', String(on));
  numberHeadingsIn(content, on);
  if (!toc.hidden) {
    buildToc();
  }
}

/** Whether headings are numbered. */
let numbering = false;

function numberHeadingsIn(root: ParentNode, on: boolean): void {
  const list = headings(root);
  const depths = nesting(list);
  const titled = depths[0] === 0 && depths.filter((d) => d === 0).length === 1;
  const counts: number[] = [];
  list.forEach((h, i) => {
    if (!on || (titled && i === 0)) {
      delete h.dataset.number;
      return;
    }
    // A lone title doesn't count as a level.
    const depth = titled ? depths[i] - 1 : depths[i];
    counts.length = depth + 1;
    counts[depth] = (counts[depth] ?? 0) + 1;
    h.dataset.number = counts.map((c) => c ?? 0).join('.');
  });
}

// ─── Rendering highlights ───────────────────────────────────────────────────

interface TextIndex {
  text: string;
  nodes: Text[];
  starts: number[];
}

/** Text nodes of the document (or a link preview); removed diff blocks are not part of it. */
function textWalker(root: Node = content): TreeWalker {
  return document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('.ma-diff-del, .ma-peek-more') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
}

function textIndex(root: Node = content): TextIndex {
  const walker = textWalker(root);
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

function wrap(root: Node, start: number, end: number, h: { id: string; color: string; note?: string }): void {
  const walker = textWalker(root);
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

function decorateFileMarks(root: ParentNode = content): void {
  for (const mark of root.querySelectorAll<HTMLElement>('mark[data-hl]')) {
    mark.classList.add('ma-hl', 'ma-file');
    mark.dataset.id = mark.dataset.hlId || '';
    mark.dataset.color = mark.dataset.hl || '';
  }
}

/** Paint stored highlights into `root`; returns how many weren't found. */
function paintStored(highlights: StoredHighlight[], root: Node = content): number {
  const index = textIndex(root);
  const stripped = strip(index.text);
  const matches: { start: number; end: number; h: StoredHighlight }[] = [];
  let unanchored = 0;
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
    wrap(root, start, end, h);
  }
  return unanchored;
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
    jump(() => window.scrollTo({ top: (Math.max(0, Math.min(y, travel)) / travel) * scrollable }));
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

/** Counts renders, so a saved offset is known to still be valid. */
let renders = 0;

function render(message: RenderMessage): void {
  renders++;
  current = message;
  const tocOpen = !toc.hidden;
  updatePalette(message.palette);
  // The link preview stays open over the re-rendered document, on the same link.
  const links = [...content.querySelectorAll('a[href]')];
  const peekIndex = peekLink ? links.indexOf(peekLink) : -1;
  content.innerHTML = message.html;
  decorateFileMarks();
  unanchored = paintStored(message.highlights);
  applyDiff(message.diff);
  applyNumbering(message.numberHeadings);
  scheduleRuler();
  updateHeader();
  if (tocOpen) {
    // Keep it open with the edited headings, without taking the focus.
    buildToc();
  }
  if (firstRender) {
    firstRender = false;
    if (viewState.scrollY) {
      window.scrollTo(0, viewState.scrollY);
    } else if (viewState.line !== undefined) {
      // A duplicate opens where the preview it came from was.
      scrollToLine(viewState.line);
    }
  }
  if (peekLink) {
    const link = content.querySelectorAll<HTMLAnchorElement>('a[href]')[peekIndex];
    if (!peek.hidden && link && link.getAttribute('href') === peekLink.getAttribute('href')) {
      peekLink = link;
      requestPeek(link);
    } else {
      hidePeek();
    }
  }
  refreshPopover();
}

/** After a re-render, move the popover to its highlight's new element, or close it if it's gone. */
function refreshPopover(): void {
  if (!popoverId) {
    return;
  }
  const anchor = firstHighlight(popoverId, popoverUri);
  if (anchor && popover.contains(document.activeElement)) {
    // Don't rebuild while the note is being typed.
    positionPopover(anchor);
  } else if (anchor) {
    showPopover(popoverId, anchor, false);
  } else {
    hidePopover();
  }
}

/** A highlight's first element: in the document, or with `uri`, in the link preview. */
function firstHighlight(id: string, uri?: string): HTMLElement | null {
  return (uri ? peekBody : content).querySelector<HTMLElement>(`.ma-hl[data-id="${CSS.escape(id)}"]`);
}

// ─── Selection → new highlight ──────────────────────────────────────────────

/** Offset of a DOM position in the text of `textIndex(root)`. */
function offsetOf(root: Node, container: Node, offset: number): number {
  const point = document.createRange();
  point.setStart(container, offset);
  const walker = textWalker(root);
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
  // In the document, or in a link preview, where it highlights the file shown.
  const inPeek = !peek.hidden && peekBody.contains(range.commonAncestorContainer);
  const root = inPeek ? peekBody : content;
  if (!root.contains(range.commonAncestorContainer)) {
    hideToolbar();
    return;
  }
  const text = textIndex(root).text;
  const quote = quoteFromRange(text, offsetOf(root, range.startContainer, range.startOffset), offsetOf(root, range.endContainer, range.endOffset));
  if (!quote) {
    hideToolbar();
    return;
  }
  pending = { quote, line: lineOf(range.startContainer), uri: inPeek ? peekUri : undefined, range: range.cloneRange() };
  // Text in a link can't be linked again.
  const node = range.commonAncestorContainer;
  const inLink = !!(node instanceof Element ? node : node.parentElement)?.closest('a') || !!range.cloneContents().querySelector('a');
  linkForm.hidden = inLink;
  resetLink();
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
  resetLink();
  CSS.highlights?.delete('ma-pending');
}

function createHighlight(color: string): void {
  if (!pending) {
    return;
  }
  post({ type: 'create', quote: pending.quote, line: pending.line, color, uri: pending.uri });
  document.getSelection()?.removeAllRanges();
  hideToolbar();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

// ─── Linking the selection ──────────────────────────────────────────────────

interface LinkOption {
  href: string;
  label: string;
  detail: string;
}

/** Files a link can point to, per file linked from (relative to its folder). */
const linkTargets = new Map<string, string[]>();
const MAX_OPTIONS = 8;
let options: LinkOption[] = [];
let activeOption = -1;

function resetLink(): void {
  linkInput.value = '';
  showOptions([]);
}

/** The file the selection is in: this one, or the one a link preview shows. */
const linkingFrom = () => pending?.uri ?? viewState.uri;

/** Sections of the file the selection is in, as `#id` links. */
function sectionOptions(query: string): LinkOption[] {
  const list = pending?.uri && pending.uri !== viewState.uri ? peekHeadings : headings().map(headingInfo);
  const q = query.toLowerCase();
  return list
    .filter((h) => h.text.toLowerCase().includes(q) || h.id.includes(q))
    .map((h) => ({ href: `#${h.id}`, label: h.number ? `${h.number}. ${h.text}` : h.text, detail: `#${h.id}` }));
}

/** Files whose path matches, those whose name starts with the query first. */
function fileOptions(query: string): LinkOption[] {
  const files = linkTargets.get(linkingFrom());
  if (!files) {
    // Asked for on focus; the answer updates the list.
    return [];
  }
  const q = query.toLowerCase();
  const rank = (path: string) => {
    const name = path.slice(path.lastIndexOf('/') + 1).toLowerCase();
    return name.startsWith(q) ? 0 : name.includes(q) ? 1 : path.toLowerCase().includes(q) ? 2 : 3;
  };
  return files
    .map((path) => ({ path, rank: rank(path) }))
    .filter((f) => f.rank < 3)
    .sort((a, b) => a.rank - b.rank || a.path.length - b.path.length)
    .slice(0, MAX_OPTIONS)
    .map(({ path }) => {
      const slash = path.lastIndexOf('/');
      return { href: path, label: path.slice(slash + 1), detail: slash < 0 ? '' : path.slice(0, slash) };
    });
}

function updateOptions(): void {
  const value = linkInput.value.trim();
  if (!value) {
    showOptions([]);
  } else if (value.startsWith('#')) {
    showOptions(sectionOptions(value.slice(1)).slice(0, MAX_OPTIONS));
  } else {
    showOptions(fileOptions(value));
  }
}

function showOptions(next: LinkOption[]): void {
  options = next;
  activeOption = -1;
  linkOptions.replaceChildren(
    ...next.map((o, i) => {
      const item = el('div', 'ma-link-option');
      item.id = `ma-link-option-${i}`;
      item.setAttribute('role', 'option');
      item.append(el('span', 'ma-link-label', o.label), el('span', 'ma-link-detail', o.detail));
      item.title = o.href;
      // Keep the focus in the box.
      item.addEventListener('mousedown', (e) => e.preventDefault());
      item.addEventListener('click', () => acceptOption(i));
      return item;
    }),
  );
  linkOptions.hidden = !next.length;
  linkInput.setAttribute('aria-expanded', String(!!next.length));
  linkInput.removeAttribute('aria-activedescendant');
}

function setActiveOption(index: number): void {
  activeOption = index;
  [...linkOptions.children].forEach((item, i) => item.setAttribute('aria-selected', String(i === index)));
  linkInput.setAttribute('aria-activedescendant', `ma-link-option-${index}`);
  linkOptions.children[index]?.scrollIntoView({ block: 'nearest' });
}

function acceptOption(index: number): void {
  const option = options[index];
  if (option) {
    linkInput.value = option.href;
    showOptions([]);
    linkInput.focus();
  }
}

/** Make the selection a link to what the box says. */
function createLink(): void {
  const href = linkInput.value.trim();
  if (!pending || !href) {
    linkInput.focus();
    return;
  }
  post({ type: 'link', quote: pending.quote, line: pending.line, href, uri: pending.uri });
  document.getSelection()?.removeAllRanges();
  hideToolbar();
}

// Focusing the box clears the page's selection, so it's drawn as a highlight meanwhile.
linkInput.addEventListener('focus', () => {
  if (pending) {
    CSS.highlights?.set('ma-pending', new Highlight(pending.range));
  }
  // Fresh each time, as files come and go.
  linkTargets.delete(linkingFrom());
  post({ type: 'linkTargets', uri: pending?.uri });
  updateOptions();
});
linkInput.addEventListener('input', updateOptions);
linkInput.addEventListener('keydown', (e) => {
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
    e.preventDefault();
    if (options.length) {
      const step = e.key === 'ArrowDown' ? 1 : -1;
      setActiveOption((activeOption + step + options.length) % options.length);
    }
  } else if ((e.key === 'Enter' || e.key === 'Tab') && activeOption >= 0) {
    e.preventDefault();
    acceptOption(activeOption);
  } else if (e.key === 'Tab' && options.length) {
    e.preventDefault();
    acceptOption(0);
  } else if (e.key === 'Escape' && options.length) {
    // Close the completions first; a second Escape closes the toolbar.
    e.stopPropagation();
    showOptions([]);
  }
});
linkForm.addEventListener('submit', (e) => {
  e.preventDefault();
  createLink();
});

// ─── Popover for an existing highlight ──────────────────────────────────────

function showPopover(id: string, anchor: HTMLElement, focusNote: boolean): void {
  if (!current) {
    return;
  }
  const color = anchor.dataset.color ?? '';
  const note = anchor.title || '';
  const isFile = anchor.classList.contains('ma-file');
  // A highlight in a link preview belongs to the file it shows.
  const uri = peekBody.contains(anchor) ? peekUri : undefined;
  popoverId = id;
  popoverUri = uri;

  const swatches = el('div', 'ma-swatches');
  swatches.append(
    ...current.palette.map((c, i) => swatch(c, i, c.name === color, () => post({ type: 'update', id, color: c.name, uri }))),
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
      post({ type: 'update', id, note: value, uri });
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
      post({ type: 'revealLine', line, uri });
    }
  });
  const remove = el('button', 'ma-danger', 'Delete');
  remove.type = 'button';
  remove.addEventListener('click', () => {
    post({ type: 'delete', id, uri });
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
  popoverUri = undefined;
}

// ─── Link preview ───────────────────────────────────────────────────────────

// Hovering a link to a heading, a line or another Markdown file shows where it
// points in a card, like the editor's hovers.
const peek = el('div', 'ma-peek');
peek.hidden = true;
const peekTitle = el('button', 'ma-peek-title');
peekTitle.type = 'button';
peekTitle.title = 'Open';
const peekBody = el('div', 'ma-peek-body markdown-body');
peek.append(peekTitle, peekBody);
document.body.appendChild(peek);

const PEEK_DELAY = 350;
const PEEK_HIDE_DELAY = 250;
/** Blocks shown from where a link points, unless a heading ends its section sooner. */
const PEEK_BLOCKS = 12;

/** The hovered link the card is for, and where the pointer entered it. */
let peekLink: HTMLAnchorElement | undefined;
let peekY = 0;
let peekTimer: ReturnType<typeof setTimeout> | undefined;
let peekHideTimer: ReturnType<typeof setTimeout> | undefined;
/** Counts requests, so an answer for a link no longer hovered is dropped. */
let peekRequest = 0;
/** The file the card shows. */
let peekUri: string | undefined;
/** All headings of the file the card shows, for linking from a selection in it. */
let peekHeadings: HeadingInfo[] = [];

/** A link within this document or to a local file (only Markdown files get an answer). */
function peekable(href: string): boolean {
  return href !== '' && href !== '#' && (!/^[a-z][\w+.-]*:/i.test(href) || href.startsWith('file:'));
}

function requestPeek(link: HTMLAnchorElement): void {
  const href = link.getAttribute('href') ?? '';
  const id = ++peekRequest;
  if (href.startsWith('#')) {
    if (current) {
      showPeek(link, { uri: viewState.uri, title: current.title, html: current.html, highlights: current.highlights });
    }
  } else {
    post({ type: 'peek', id, href });
  }
}

/** The part of a rendered document a link's `#fragment` points to: a heading's section, or from a line on. */
function peekSection(root: DocumentFragment, fragment: string): { blocks: Element[]; place?: string; more: boolean } | string {
  const top = [...root.children];
  let start = 0;
  let place: string | undefined;
  const lineMatch = /^L(\d+)/.exec(fragment);
  if (lineMatch) {
    const line = Number(lineMatch[1]) - 1;
    // The block the line is in: the last one starting at or before it.
    top.forEach((b, i) => {
      if ((blockLine(b) ?? Infinity) <= line) {
        start = i;
      }
    });
    place = `line ${line + 1}`;
  } else if (fragment) {
    let id = fragment;
    try {
      id = decodeURIComponent(fragment);
    } catch {
      // Keep as written.
    }
    const target = root.querySelector(`[id="${CSS.escape(id)}"]`);
    if (!target) {
      return `No heading #${id}`;
    }
    start = Math.max(0, top.findIndex((b) => b.contains(target)));
    const number = (target as HTMLElement).dataset.number;
    place = `${number ? `${number}. ` : ''}${target.textContent?.trim() || `#${id}`}`;
  }
  const level = headingLevel(top[start]);
  const endsSection = (b: Element) => !!level && (headingLevel(b) ?? 7) <= level;
  let end = start + 1;
  while (end < top.length && end - start < PEEK_BLOCKS && !endsSection(top[end])) {
    end++;
  }
  return { blocks: top.slice(start, end), place, more: end < top.length && !endsSection(top[end]) };
}

function headingLevel(node: Element | undefined): number | undefined {
  const m = /^H([1-6])$/.exec(node?.tagName ?? '');
  return m ? Number(m[1]) : undefined;
}

function showPeek(link: HTMLAnchorElement, shown: { uri: string; title: string; html?: string; highlights?: StoredHighlight[]; error?: string }): void {
  if (link !== peekLink || !link.isConnected) {
    return;
  }
  // The same file again (after a change) keeps its place in the card.
  const refresh = !peek.hidden && peekUri === shown.uri;
  const scrollTop = peekBody.scrollTop;
  peekUri = shown.uri;
  const fragment = (link.getAttribute('href') ?? '').split('#')[1] ?? '';
  const template = el('template');
  template.innerHTML = shown.html ?? '';
  // Numbered and highlighted across the whole document, as in its own preview.
  numberHeadingsIn(template.content, numbering);
  decorateFileMarks(template.content);
  paintStored(shown.highlights ?? [], template.content);
  peekHeadings = headings(template.content).map(headingInfo);
  const section = shown.error ?? peekSection(template.content, fragment);
  peekTitle.textContent = typeof section === 'object' && section.place ? `${shown.title} › ${section.place}` : shown.title;
  if (typeof section === 'string') {
    peekBody.replaceChildren(el('p', 'ma-peek-error', section));
  } else {
    const holder = el('div');
    holder.append(...section.blocks);
    // Ids would clash with the document's; source lines stay, for new highlights' line hints.
    for (const node of holder.querySelectorAll('[id]')) {
      node.removeAttribute('id');
    }
    peekBody.replaceChildren(...holder.childNodes);
    if (section.more) {
      peekBody.append(el('p', 'ma-peek-more', '…'));
    }
  }
  peek.hidden = false;
  peekBody.scrollTop = refresh ? scrollTop : 0;
  positionPeek(link);
  if (popoverUri) {
    refreshPopover();
  }
}

/** While text in the card is selected or one of its highlights is open, it stays. */
function peekPinned(): boolean {
  if (peek.hidden) {
    return false;
  }
  // The toolbar is up for a selection in the card (maybe with the focus in the link box).
  return (!toolbar.hidden && !!pending?.uri) || (!popover.hidden && !!popoverUri);
}

/** Below the hovered line of the link, or above it when there is more room there. */
function positionPeek(link: HTMLElement): void {
  const rects = [...link.getClientRects()];
  const rect = rects.find((r) => peekY >= r.top && peekY <= r.bottom) ?? rects[0] ?? link.getBoundingClientRect();
  const gap = 6;
  const below = window.innerHeight - rect.bottom - gap - 8;
  const above = rect.top - header.getBoundingClientRect().bottom - gap - 8;
  peek.style.maxHeight = '';
  const natural = peek.offsetHeight;
  const showBelow = natural <= below || below >= above;
  peek.style.maxHeight = `${Math.max(80, showBelow ? below : above)}px`;
  const top = showBelow ? rect.bottom + gap : rect.top - gap - peek.offsetHeight;
  const left = clamp(rect.left, 8, window.innerWidth - peek.offsetWidth - 8);
  peek.style.top = `${top + window.scrollY}px`;
  peek.style.left = `${left + window.scrollX}px`;
}

function hidePeek(): void {
  clearTimeout(peekTimer);
  clearTimeout(peekHideTimer);
  peekLink = undefined;
  peekUri = undefined;
  peekRequest++;
  peek.hidden = true;
  peekBody.replaceChildren();
  // The toolbar and popover of a highlight in the card go with it.
  if (pending?.uri) {
    hideToolbar();
  }
  if (popoverUri) {
    hidePopover();
  }
}

/** Hide soon, so the pointer can cross from the link to the card. */
function leavePeek(e: MouseEvent): void {
  const to = e.relatedTarget;
  if (to instanceof Node && (peekLink?.contains(to) || peek.contains(to))) {
    return;
  }
  // Not while selecting text in it, or annotating.
  if (e.buttons || peekPinned()) {
    clearTimeout(peekHideTimer);
    return;
  }
  clearTimeout(peekHideTimer);
  if (peek.hidden) {
    hidePeek();
  } else {
    peekHideTimer = setTimeout(hidePeek, PEEK_HIDE_DELAY);
  }
}

content.addEventListener('mouseover', (e) => {
  const link = (e.target as Element).closest?.<HTMLAnchorElement>('a[href]');
  if (!link) {
    return;
  }
  if (link === peekLink) {
    clearTimeout(peekHideTimer);
    return;
  }
  // Not while selecting text, or annotating in the card.
  if (e.buttons || peekPinned() || !peekable(link.getAttribute('href') ?? '')) {
    return;
  }
  hidePeek();
  peekLink = link;
  peekY = e.clientY;
  peekTimer = setTimeout(() => requestPeek(link), PEEK_DELAY);
});
content.addEventListener('mouseout', (e) => {
  if (peekLink && peekLink.contains(e.target as Node)) {
    leavePeek(e);
  }
});
peek.addEventListener('mouseenter', () => clearTimeout(peekHideTimer));
peek.addEventListener('mouseleave', (e) => leavePeek(e));
// The title goes where the link does.
peekTitle.addEventListener('click', () => {
  const link = peekLink;
  hidePeek();
  link?.click();
});
peek.addEventListener('click', (e) => {
  const target = e.target as Element;
  // Links in the card stay put: VS Code's frame would otherwise follow them.
  if (target.closest('a')) {
    e.preventDefault();
    e.stopPropagation();
  }
  const hl = target.closest<HTMLElement>('.ma-hl');
  if (hl && peekBody.contains(hl) && document.getSelection()?.isCollapsed !== false && hl.dataset.id) {
    showPopover(hl.dataset.id, hl, false);
  }
});

// ─── Events ─────────────────────────────────────────────────────────────────

document.addEventListener('mouseup', (e) => {
  if (toolbar.contains(e.target as Node) || popover.contains(e.target as Node)) {
    return;
  }
  setTimeout(onSelectionChange, 0);
});

document.addEventListener('keyup', (e) => {
  if (toolbar.contains(e.target as Node)) {
    return;
  }
  if (e.shiftKey || e.key === 'Shift' || ((e.metaKey || e.ctrlKey) && e.key === 'a')) {
    onSelectionChange();
  }
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideToolbar();
    hidePopover();
    hidePeek();
    hideToc();
    return;
  }
  // Digits pick a colour, except when typed into the link box.
  const typing = (e.target as Element).closest?.('input, textarea');
  if (!typing && !toolbar.hidden && pending && current && /^[1-9]$/.test(e.key) && !e.metaKey && !e.ctrlKey && !e.altKey) {
    const color = current.palette[Number(e.key) - 1];
    if (color) {
      e.preventDefault();
      createHighlight(color.name);
    }
  }
});

document.addEventListener('mousedown', (e) => {
  const target = e.target as Node;
  // The colour toolbar and popover act on the card, so using them keeps it.
  if (!peek.contains(target) && !toolbar.contains(target) && !popover.contains(target)) {
    hidePeek();
  }
  if (!toc.contains(target) && !tocButton.contains(target)) {
    hideToc();
  }
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
    // VS Code's webview frame also listens for link clicks on the window, and
    // scrolls to `#fragment` targets itself; links are handled here instead.
    e.stopPropagation();
    const href = link.getAttribute('href') ?? '';
    if (href && (e.metaKey || e.ctrlKey) && e.altKey) {
      // As in the editor, the chord opens the target to the side: here, in a new preview.
      const anchor = href.startsWith('#') ? document.getElementById(decodeURIComponent(href.slice(1))) : null;
      post({ type: 'openLinkToSide', href, line: anchor ? lineOf(anchor) : undefined });
      stayAt(window.scrollY);
      return;
    }
    if (href.startsWith('#')) {
      const target = document.getElementById(decodeURIComponent(href.slice(1)));
      if (target) {
        jump(() => target.scrollIntoView({ block: 'start' }));
      }
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
  // Sent even with sync off: a duplicate of this preview opens at the same place.
  if (current && Date.now() >= quietUntil && !syncFrame) {
    syncFrame = requestAnimationFrame(() => {
      syncFrame = 0;
      const line = topLine();
      if (line !== undefined) {
        post({ type: 'scrolled', line });
      }
    });
  }
});

// ─── Scroll sync ────────────────────────────────────────────────────────────

/** Until then, scroll events are the result of following the editor and aren't sent back. */
let quietUntil = 0;
let syncFrame = 0;

/** Source-mapped elements in document order, with where each starts on the page. */
function lineAnchors(): { line: number; top: number }[] {
  const anchors: { line: number; top: number }[] = [];
  for (const node of content.querySelectorAll<HTMLElement>('[data-line]')) {
    const line = Number(node.dataset.line);
    // Keep lines and positions both increasing, so either can be interpolated.
    const last = anchors[anchors.length - 1];
    const top = node.getBoundingClientRect().top + window.scrollY;
    if (!last || (line > last.line && top > last.top)) {
      anchors.push({ line, top });
    }
  }
  return anchors;
}

/** Page offset that puts content just below the header. */
const syncOffset = () => header.offsetHeight + 8;

// Jumps to headings (links, the table of contents) land below the sticky header, not under it.
new ResizeObserver(() => {
  document.documentElement.style.scrollPaddingTop = `${syncOffset()}px`;
}).observe(header);

/** Source line at the top of the view, interpolated between source-mapped elements. */
function topLine(): number | undefined {
  const anchors = lineAnchors();
  const y = window.scrollY + syncOffset();
  let i = anchors.length - 1;
  while (i > 0 && anchors[i].top > y) {
    i--;
  }
  const a = anchors[i];
  const b = anchors[i + 1];
  if (!a) {
    return undefined;
  }
  if (!b || y <= a.top) {
    return a.line;
  }
  return Math.floor(a.line + ((y - a.top) / (b.top - a.top)) * (b.line - a.line));
}

/** Scroll so `line` is at the top. When following the editor, the scroll isn't sent back to it. */
function scrollToLine(line: number, follow = true): void {
  const anchors = lineAnchors();
  let i = anchors.length - 1;
  while (i > 0 && anchors[i].line > line) {
    i--;
  }
  const a = anchors[i];
  const b = anchors[i + 1];
  let top = 0;
  if (a && a.line <= line) {
    top = b ? a.top + ((line - a.line) / (b.line - a.line)) * (b.top - a.top) : a.top;
  }
  if (follow) {
    quietUntil = Date.now() + 300;
  }
  window.scrollTo({ top: top - syncOffset() });
}

/** Undo any scroll in the next moment, in case something else still reacts to a click (this view stays put). */
function stayAt(y: number): void {
  const restore = () => {
    if (window.scrollY !== y) {
      quietUntil = Date.now() + 300;
      window.scrollTo({ top: y });
    }
  };
  requestAnimationFrame(restore);
  setTimeout(restore, 50);
}

// ─── Table of contents ──────────────────────────────────────────────────────

const toc = el('nav', 'ma-toc');
toc.id = 'ma-toc';
toc.setAttribute('aria-label', 'Table of contents');
toc.hidden = true;
document.body.appendChild(toc);

interface HeadingInfo {
  id: string;
  text: string;
  number?: string;
}

const headingInfo = (h: HTMLElement): HeadingInfo => ({ id: h.id, text: h.textContent?.trim() ?? '', number: h.dataset.number });

/** The document's headings (removed diff blocks have none: their ids are cleared). */
function headings(root: ParentNode = content): HTMLElement[] {
  return [...root.querySelectorAll<HTMLElement>(':is(h1, h2, h3, h4, h5, h6)[id]')];
}

/** How deep each heading is nested under the ones before it, skipped levels collapsed (an h4 under an h2 is one deeper). */
function nesting(list: HTMLElement[]): number[] {
  const open: number[] = [];
  return list.map((h) => {
    const level = Number(h.tagName[1]);
    while (open.length && open[open.length - 1] >= level) {
      open.pop();
    }
    open.push(level);
    return open.length - 1;
  });
}

/** The heading whose section is at the top of the view. */
function currentHeading(list: HTMLElement[]): HTMLElement | undefined {
  const y = header.offsetHeight + 8 + 1;
  let found: HTMLElement | undefined;
  for (const h of list) {
    if (h.getBoundingClientRect().top > y) {
      break;
    }
    found = h;
  }
  return found ?? list[0];
}

function buildToc(): void {
  const list = headings();
  if (!list.length) {
    toc.replaceChildren(el('p', 'ma-toc-empty', 'No headings'));
    return;
  }
  const depths = nesting(list);
  const now = currentHeading(list);
  toc.replaceChildren(
    ...list.map((h, i) => {
      const item = el('button', 'ma-toc-item', h.textContent?.trim() || h.id);
      if (h.dataset.number) {
        item.prepend(el('span', 'ma-toc-number', `${h.dataset.number}.`));
      }
      item.type = 'button';
      item.style.paddingLeft = `${10 + depths[i] * 14}px`;
      item.title = item.textContent ?? '';
      if (h === now) {
        item.setAttribute('aria-current', 'location');
      }
      item.addEventListener('click', () => {
        hideToc();
        jump(() => h.scrollIntoView({ block: 'start' }));
      });
      return item;
    }),
  );
}

function showToc(): void {
  buildToc();
  toc.hidden = false;
  tocButton.setAttribute('aria-expanded', 'true');
  toc.style.top = `${header.getBoundingClientRect().bottom + 4}px`;
  const current = toc.querySelector<HTMLElement>('[aria-current]') ?? toc.querySelector<HTMLElement>('.ma-toc-item');
  current?.scrollIntoView({ block: 'center' });
  current?.focus();
}

function hideToc(): void {
  if (toc.hidden) {
    return;
  }
  const hadFocus = toc.contains(document.activeElement);
  toc.hidden = true;
  tocButton.setAttribute('aria-expanded', 'false');
  if (hadFocus) {
    tocButton.focus();
  }
}

tocButton.addEventListener('click', () => (toc.hidden ? showToc() : hideToc()));

// Arrow keys move through the headings; Enter goes to one (the items are buttons).
toc.addEventListener('keydown', (e) => {
  const items = [...toc.querySelectorAll<HTMLElement>('.ma-toc-item')];
  const i = items.indexOf(document.activeElement as HTMLElement);
  const next =
    e.key === 'ArrowDown' ? items[Math.min(i + 1, items.length - 1)]
    : e.key === 'ArrowUp' ? items[Math.max(i - 1, 0)]
    : e.key === 'Home' ? items[0]
    : e.key === 'End' ? items[items.length - 1]
    : undefined;
  if (next) {
    e.preventDefault();
    next.focus();
  } else if (e.key === 'Tab') {
    hideToc();
  }
});

// ─── Back and forward ───────────────────────────────────────────────────────

/** A place in the document: its offset, or after a re-render its source line, which survives edits above it. */
interface Place {
  line?: number;
  y: number;
  render: number;
}

const MAX_HISTORY = 50;
const places: Place[] = [];
/** Index in `places` of where the view is now, or -1 before the first jump. */
let at = -1;

const here = (): Place => ({ line: topLine(), y: window.scrollY, render: renders });

function updateNav(): void {
  backButton.disabled = at <= 0;
  forwardButton.disabled = at < 0 || at >= places.length - 1;
}

/** Run a scroll that takes the view elsewhere, so Back returns to where it was. */
function jump(go: () => void): void {
  const from = here();
  go();
  if (Math.abs(window.scrollY - from.y) < 1) {
    return;
  }
  // Going somewhere new drops the forward history, as in a browser.
  places.splice(Math.max(at, 0), Infinity, from, here());
  if (places.length > MAX_HISTORY) {
    places.splice(0, places.length - MAX_HISTORY);
  }
  at = places.length - 1;
  updateNav();
}

function goTo(index: number): void {
  if (index < 0 || index >= places.length || at < 0) {
    return;
  }
  // Remember where the view was left, including any scrolling since the jump.
  places[at] = here();
  at = index;
  const place = places[at];
  if (place.render !== renders && place.line !== undefined) {
    scrollToLine(place.line, false);
  } else {
    window.scrollTo({ top: place.y });
  }
  updateNav();
}

const goBack = () => goTo(at - 1);
const goForward = () => goTo(at + 1);

document.addEventListener('keydown', (e) => {
  const editing = (e.target as HTMLElement).closest?.('textarea, input');
  if (editing) {
    return;
  }
  const back = (e.altKey && e.key === 'ArrowLeft') || ((e.metaKey || e.ctrlKey) && e.key === '[');
  const forward = (e.altKey && e.key === 'ArrowRight') || ((e.metaKey || e.ctrlKey) && e.key === ']');
  if (back || forward) {
    e.preventDefault();
    (back ? goBack : goForward)();
  }
});

// The mouse's back and forward buttons.
window.addEventListener('mouseup', (e) => {
  if (e.button === 3 || e.button === 4) {
    e.preventDefault();
    (e.button === 3 ? goBack : goForward)();
  }
});

function focusHighlight(id: string): void {
  const spans = content.querySelectorAll<HTMLElement>(`.ma-hl[data-id="${CSS.escape(id)}"]`);
  if (!spans.length) {
    return;
  }
  jump(() => spans[0].scrollIntoView({ block: 'center' }));
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
    case 'goToLine':
      jump(() => scrollToLine(message.line));
      break;
    case 'scrollToLine':
      scrollToLine(message.line);
      break;
    case 'focusHighlight':
      focusHighlight(message.id);
      break;
    case 'peek':
      if (message.id === peekRequest && peekLink) {
        showPeek(peekLink, message);
      }
      break;
    case 'linkTargets':
      linkTargets.set(message.base, message.files);
      if (document.activeElement === linkInput && linkingFrom() === message.base) {
        updateOptions();
      }
      break;
    case 'peekChanged':
      if (peekLink && message.uri === peekUri) {
        requestPeek(peekLink);
      }
      break;
  }
});

post({ type: 'ready', diff: viewState.diff, scrollSync: viewState.scrollSync });
