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
  numberHeadings: boolean;
  /** Present while the diff view is on: the diff, or why there is none. */
  diff?: { view: DiffView; base: string } | { unavailable: string };
}

export type ToWebview =
  | RenderMessage
  | { type: 'scrollToLine'; line: number }
  /** Go to a line as a jump, which Back returns from. */
  | { type: 'goToLine'; line: number }
  | { type: 'focusHighlight'; id: string }
  | PeekResult
  /** Files a link can point to, relative to the folder of `base` (the file being linked from). */
  | { type: 'linkTargets'; base: string; files: string[] }
  /** Highlights in the file the link preview shows changed: ask for it again. */
  | { type: 'peekChanged'; uri: string };

/** The answer to a `peek`: another Markdown file rendered, or why it can't be shown. */
export interface PeekResult {
  type: 'peek';
  id: number;
  /** The file shown, which highlights made in the card go to. */
  uri: string;
  title: string;
  html?: string;
  highlights?: StoredHighlight[];
  error?: string;
}

export type FromWebview =
  | { type: 'ready'; diff?: boolean; scrollSync?: boolean }
  | { type: 'setDiff'; value: boolean }
  /** Highlight operations; `uri` is another file's, for highlights in a link preview. */
  | { type: 'create'; quote: TextQuote; line?: number; color: string; uri?: string }
  | { type: 'update'; id: string; color?: string; note?: string; uri?: string }
  | { type: 'delete'; id: string; uri?: string }
  | { type: 'revealLine'; line: number; uri?: string }
  /** Make the selected text a link to `href`. */
  | { type: 'link'; quote: TextQuote; line?: number; href: string; uri?: string }
  /** Ask for the files a link from `uri` (by default this preview's file) can point to. */
  | { type: 'linkTargets'; uri?: string }
  | { type: 'setWriteToFile'; value: boolean }
  | { type: 'setScrollSync'; value: boolean }
  /** The preview was scrolled by the user; `line` is the source line now at its top. */
  | { type: 'scrolled'; line: number }
  | { type: 'setTheme'; value: PreviewTheme }
  | { type: 'setNumberHeadings'; value: boolean }
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
