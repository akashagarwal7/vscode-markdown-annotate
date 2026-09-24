/**
 * Preview webview: renders the document HTML, paints highlights, and turns
 * text selections into highlight requests for the extension.
 */
import { findQuote, quoteFromRange, strip, TextQuote } from '../core/anchor';
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
let viewState: WebviewState = { ...vscode.getState(), uri: initialState.uri };
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

header.append(titleEl, countEl, el('span', 'ma-spacer'), themeSwitch, toggleLabel);
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

function textIndex(): TextIndex {
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
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
  const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
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

function render(message: RenderMessage): void {
  current = message;
  updatePalette(message.palette);
  content.innerHTML = message.html;
  decorateFileMarks();
  paintStored(message.highlights);
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

function offsetOf(container: Node, offset: number): number {
  const range = document.createRange();
  range.setStart(content, 0);
  range.setEnd(container, offset);
  return range.toString().length;
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

post({ type: 'ready' });
