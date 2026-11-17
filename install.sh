#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Markdown Annotate — build a .vsix and install it into VS Code and/or Cursor
# Usage: ./install.sh
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

EXT_VERSION="$(node -p "require('./package.json').version")"
VSIX_FILE="vscode-markdown-annotate-${EXT_VERSION}.vsix"

echo "==> Markdown Annotate installer"
echo "    version : ${EXT_VERSION}"
echo "    vsix    : ${VSIX_FILE}"
echo ""

echo "==> Installing dependencies…"
npm install --silent

echo "==> Packaging extension…"
if command -v vsce &>/dev/null; then
  vsce package --out "${VSIX_FILE}"
else
  npx --yes @vscode/vsce package --out "${VSIX_FILE}"
fi

# Each editor's own CLI. Prefer the one inside the app: Cursor's installer can
# point `code` on PATH at Cursor, which would install into Cursor twice.
editor_cli() { # <app bundle> <command on PATH>
  local bundled="/Applications/$1/Contents/Resources/app/bin/$2"
  if [[ -x "$bundled" ]]; then
    echo "$bundled"
  elif command -v "$2" &>/dev/null; then
    command -v "$2"
  fi
}

installed=0
seen=""
for editor in "Visual Studio Code.app:code:VS Code" "Cursor.app:cursor:Cursor"; do
  IFS=: read -r app cmd name <<<"$editor"
  cli="$(editor_cli "$app" "$cmd")"
  [[ -n "$cli" ]] || continue
  # Skip a CLI that is the same as one already used (a symlink to it).
  real="$(readlink -f "$cli" 2>/dev/null || echo "$cli")"
  [[ "$seen" == *"|$real|"* ]] && continue
  seen+="|$real|"
  echo "==> Installing into ${name}…"
  "$cli" --install-extension "${VSIX_FILE}" --force
  installed=1
done

if [[ $installed -eq 0 ]]; then
  echo "  Neither 'code' nor 'cursor' is on PATH. Install ${VSIX_FILE} manually via"
  echo "  Extensions → ⋯ → Install from VSIX…"
  exit 1
fi

echo ""
echo "✓ Installed. Reload the editor window to activate Markdown Annotate."
