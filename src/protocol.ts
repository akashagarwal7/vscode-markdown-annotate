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

export interface RenderMessage {
  type: 'render';
  html: string;
  title: string;
  highlights: StoredHighlight[];
  palette: PaletteColor[];
  writeToFile: boolean;
  theme: PreviewTheme;
}

export type ToWebview =
  | RenderMessage
  | { type: 'scrollToLine'; line: number }
  | { type: 'focusHighlight'; id: string };

export type FromWebview =
  | { type: 'ready' }
  | { type: 'create'; quote: TextQuote; line?: number; color: string }
  | { type: 'update'; id: string; color?: string; note?: string }
  | { type: 'delete'; id: string }
  | { type: 'revealLine'; line: number }
  | { type: 'setWriteToFile'; value: boolean }
  | { type: 'setTheme'; value: PreviewTheme }
  | { type: 'openLink'; href: string };

export interface WebviewState {
  uri: string;
  scrollY?: number;
}
