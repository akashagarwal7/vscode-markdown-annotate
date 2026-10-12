# Changelog

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
