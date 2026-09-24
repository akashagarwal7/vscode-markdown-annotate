#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# Markdown Annotate — test, build and publish to the VS Code Marketplace
# Usage: ./publish.sh            (requires `vsce login akashagarwal` beforehand)
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

EXT_VERSION="$(node -p "require('./package.json').version")"

echo "==> Markdown Annotate publisher"
echo "    version : ${EXT_VERSION}"
echo ""

# ── 1. Install dependencies ───────────────────────────────────────────────────
echo "==> Installing dependencies…"
npm install --silent

# ── 2. Unit tests ─────────────────────────────────────────────────────────────
echo "==> Running unit tests…"
npm test --silent

# ── 3. Publish (vscode:prepublish type-checks and bundles) ────────────────────
echo "==> Publishing to VS Code Marketplace…"
if command -v vsce &>/dev/null; then
  vsce publish
else
  echo "    vsce not found globally — using npx @vscode/vsce"
  npx --yes @vscode/vsce publish
fi

echo ""
echo "✓ Published v${EXT_VERSION} to the VS Code Marketplace."
echo "  https://marketplace.visualstudio.com/items?itemName=akashagarwal.vscode-markdown-annotate"
