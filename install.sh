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

installed=0
for cli in code cursor; do
  if command -v "$cli" &>/dev/null; then
    echo "==> Installing into ${cli}…"
    "$cli" --install-extension "${VSIX_FILE}" --force
    installed=1
  fi
done

if [[ $installed -eq 0 ]]; then
  echo "  Neither 'code' nor 'cursor' is on PATH. Install ${VSIX_FILE} manually via"
  echo "  Extensions → ⋯ → Install from VSIX…"
  exit 1
fi

echo ""
echo "✓ Installed. Reload the editor window to activate Markdown Annotate."
