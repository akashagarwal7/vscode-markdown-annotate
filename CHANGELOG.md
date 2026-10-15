# Changelog

## 0.11.0

- The colour picker that appears on a selection has a link box: type a path or `#` a section, with completions of the workspace's files and the file's headings, and press **Link** to make the selected text a Markdown link. Works in link previews too, linking in the linked file.
- **Undo** and **Redo** buttons in the preview header take back, or do again, the highlights, colour changes, notes, deletions and links made in that preview, stored or written into the file. Also `Cmd/Ctrl+Z` and `Cmd+Shift+Z` (`Ctrl+Y`).

## 0.10.0

- Link previews show the linked file's highlights, and you can annotate in them: select text to highlight it, or click a highlight to recolour it, add a note or delete it. Changes go to the linked file. The card stays open while you select text in it or edit one of its highlights.

## 0.9.0

- The numbered-list button in the preview header numbers the headings (1., 1.1., 1.2.1. and so on), in the preview, the table of contents and link previews. A lone top heading, the document's title, is left unnumbered. It's kept for every file, in the `markdownAnnotate.numberHeadings` setting.

## 0.8.0

- Hovering a link to a heading, a line or another Markdown file shows where it points in a floating card, like the editor's hovers: the heading's section, or the start of the file. Click the card's title to follow the link.
- The **☰** button at the top left of the preview opens a table of contents of the document's headings, with the section you're reading marked. Click a heading, or use the arrow keys and Enter, to go there; **Back** returns.
- Jumping to a heading no longer leaves it hidden under the preview header.

## 0.7.0

- **Sync scroll** is set separately for each preview, so turning it off in one no longer turns it off in the other. The `markdownAnnotate.scrollSync` setting now sets it for newly opened previews. A second preview opened beside the first starts with it off.

## 0.6.0

- **Duplicate Annotatable Preview** (the split icon in a preview's title bar) opens a second preview of the file beside the first, at the same place, to read two parts of a long file side by side.
- `Cmd+Alt+click` (`Ctrl+Alt+click`) on a link shows it in the other preview, at the heading it points to, switching files if needed. The focus stays where you clicked.
- Up to two previews are open at a time. Opening a preview for a third file replaces the one you looked at least recently.
- With **Sync scroll** on, the editor follows the preview you last scrolled or focused.

## 0.5.0

- **← →** buttons in the preview header go back and forward through jumps within the preview: links to headings, highlights picked in the sidebar, and clicks on the scrollbar. Also `Cmd/Ctrl+[` and `]`, `Alt+←` and `→`, and the mouse's back and forward buttons.

## 0.4.0

- Scrolling the preview scrolls the editor too. The **Sync scroll** checkbox in the preview header turns syncing on and off in both directions (on by default).
- Scroll sync keeps your place within long paragraphs instead of jumping to their first line.

## 0.3.0

- **Git diff** marks tables row by row: editing one row no longer marks the whole table, and removed rows show in place.
- **Git diff** marks the words that changed within an edited paragraph or row in a stronger colour, as the editor's inline diff does.

## 0.2.0

- **Git diff** button in the preview header, on by default: show changes since the last commit (`HEAD`) as a rendered diff, with change marks on the scrollbar.
- Highlights are marked on the preview's scrollbar in their colours; highlights with a note are outlined.
- The preview draws its own scrollbar, so the marks show in VS Code and Cursor alike.
- The README carries a few real highlights to try the preview on.

## 0.1.0

- Annotatable Markdown preview: select text and pick a colour to highlight it.
- Click a highlight to recolour it, add a note, jump to the source, or delete it.
- Optional write-back: store highlights separately (default) or write them into the Markdown file as `<mark data-hl="…">` tags; move existing highlights either way.
- Storage in VS Code workspace storage or a shareable `.annotations.json` sidecar.
- Highlights tinted in the source editor, listed in the Explorer's **Markdown Highlights** view, and exportable as Markdown.
- Syntax highlighting for fenced code blocks (GitHub light/dark colours), with language auto-detection for untagged fences. Shell blocks also colour command names and flags.
- Code uses the text colour rather than VS Code's yellow preformatted-text colour.
- Auto / Light / Dark switch in the preview header, independent of the VS Code theme.
- Configurable palette; keys `1`–`9` apply a colour to the current selection.
