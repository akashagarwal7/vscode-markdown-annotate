/** Messages exchanged between the extension host and the preview webview. */
import type { TextQuote } from './core/anchor';

export type PreviewTheme = 'auto' | 'light' | 'dark';

export interface PaletteColor {
  name: string;
  color: string;
}

/** A highlight kept in the annotation store (not in the Markdown file). */
export interface StoredHighlight {
  id: string;
  color: string;
  quote: TextQuote;
  /** Source line the highlight started on when created; a matching hint. */
  line?: number;
  note?: string;
  createdAt: number;
}

/** A rendered diff of the document against a git revision. */
export interface DiffView {
  /** Start lines of the top-level blocks that are new or changed. */
  changed: number[];
  /** Start lines of the new or changed rows of tables diffed by row. */
  changedRows: number[];
  /**
   * Rendered old blocks, each to be shown before the block starting at `before`
   * (or at the end). With `table`, they are `<tr>`s of the table starting at
   * that line, and `before` is the start line of one of its rows.
   */
  removed: { before?: number; table?: number; html: string }[];
}

export interface RenderMessage {
  type: 'render';
  html: string;
  title: string;
  highlights: StoredHighlight[];
  palette: PaletteColor[];
  writeToFile: boolean;
  scrollSync: boolean;
  theme: PreviewTheme;
  /** Present while the diff view is on: the diff, or why there is none. */
  diff?: { view: DiffView; base: string } | { unavailable: string };
}

export type ToWebview =
  | RenderMessage
  | { type: 'scrollToLine'; line: number }
  /** Go to a line as a jump, which Back returns from. */
  | { type: 'goToLine'; line: number }
  | { type: 'focusHighlight'; id: string }
  | PeekResult;

/** The answer to a `peek`: another Markdown file rendered, or why it can't be shown. */
export interface PeekResult {
  type: 'peek';
  id: number;
  title: string;
  html?: string;
  error?: string;
}

export type FromWebview =
  | { type: 'ready'; diff?: boolean; scrollSync?: boolean }
  | { type: 'setDiff'; value: boolean }
  | { type: 'create'; quote: TextQuote; line?: number; color: string }
  | { type: 'update'; id: string; color?: string; note?: string }
  | { type: 'delete'; id: string }
  | { type: 'revealLine'; line: number }
  | { type: 'setWriteToFile'; value: boolean }
  | { type: 'setScrollSync'; value: boolean }
  /** The preview was scrolled by the user; `line` is the source line now at its top. */
  | { type: 'scrolled'; line: number }
  | { type: 'setTheme'; value: PreviewTheme }
  | { type: 'openLink'; href: string }
  /** Cmd/Ctrl+Alt+click: open the link in a new preview beside; `line` is where an in-document link points. */
  | { type: 'openLinkToSide'; href: string; line?: number }
  /** A link to another Markdown file is hovered: render it for a preview card. */
  | { type: 'peek'; id: number; href: string };

export interface WebviewState {
  uri: string;
  scrollY?: number;
  diff?: boolean;
  /** For a new duplicate preview: the source line to open at. */
  line?: number;
  /** This preview's Sync scroll; unset until chosen, then the `scrollSync` setting applies. */
  scrollSync?: boolean;
}
