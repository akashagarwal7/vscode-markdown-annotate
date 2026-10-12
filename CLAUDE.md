# CLAUDE.md

## After changing the extension

Tests and the browser harness (`npm run harness`, then open `test/harness/index.html`) don't touch the copy of the extension installed in the editor. After any change to `src/` or `media/`, finish by telling the user to (re)install it locally:

```sh
./install.sh
```

This builds a `.vsix` and installs it into VS Code and/or Cursor. They then need to reload the editor window (**Developer: Reload Window**). Don't run it yourself unless asked; it changes the user's editor.
