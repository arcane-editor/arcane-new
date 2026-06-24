#!/usr/bin/env bash
#
# Build the arcane-graph sidecar binary for the current platform.
# Drops the result at src-tauri/binaries/arcane-graph-<target-triple>
# so Tauri picks it up as a sidecar at bundle time.
#
# Run from anywhere:  bash tooling/arcane-graph-sidecar/build.sh
# Requires: uv (https://github.com/astral-sh/uv), rustc (for target-triple resolution)

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if ! command -v uv >/dev/null 2>&1; then
    echo "error: uv is not installed. Install from https://github.com/astral-sh/uv" >&2
    exit 1
fi

# Resolve the Rust target triple so the output filename matches what Tauri
# expects (it appends the triple automatically when bundling).
TARGET_TRIPLE="$(rustc -vV | awk -F': ' '/^host/ {print $2}')"

cd "$SCRIPT_DIR"
rm -rf build dist

# uv handles Python version pinning + venv + fast installs in one tool.
# 3.12 is the sweet spot for graphifyy's dep cone right now (3.14 host is too
# new for several transitive deps; 3.11 also works as a fallback).
PYTHON_VERSION="${ARCANE_GRAPH_PYTHON:-3.12}"
uv venv --python "$PYTHON_VERSION" --seed .venv
# shellcheck disable=SC1091
source .venv/bin/activate

uv pip install graphifyy pyinstaller

python -m PyInstaller pyinstaller.spec --noconfirm

OUT_DIR="$REPO_ROOT/src-tauri/binaries"
mkdir -p "$OUT_DIR"
case "$OSTYPE" in
    msys*|cygwin*|win32) EXT=".exe" ;;
    *) EXT="" ;;
esac
OUT_FILE="$OUT_DIR/arcane-graph-${TARGET_TRIPLE}${EXT}"
cp "dist/arcane-graph${EXT}" "$OUT_FILE"
chmod +x "$OUT_FILE"

echo
echo "Built: $OUT_FILE"
ls -lh "$OUT_FILE"
