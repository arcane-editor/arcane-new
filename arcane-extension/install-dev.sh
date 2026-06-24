#!/bin/bash
# DEV ONLY: Copies Arcane Editor scripts into a Unity project's Assets/Editor/Arcane/ folder
# and writes a dev config so Unity knows where to find the Arcane dev launcher.
# Usage: ./install-dev.sh [unity_project_path]
# Default: /Users/inno/My project

UNITY_PROJECT="${1:-/Users/inno/My project}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ARCANE_ROOT="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="$SCRIPT_DIR/Editor"
DEST_DIR="$UNITY_PROJECT/Assets/Editor/Arcane"
DEV_LAUNCHER="$ARCANE_ROOT/arcane-edior/arcane-dev.sh"

if [ ! -d "$UNITY_PROJECT/Assets" ]; then
    echo "Error: '$UNITY_PROJECT' does not look like a Unity project (no Assets/ folder)."
    exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SOURCE_DIR"/*.cs "$DEST_DIR/"

# Write dev config file so ArcaneEditor.cs knows where the launcher is
echo "$DEV_LAUNCHER" > "$UNITY_PROJECT/.arcane-dev-path"

echo "Copied Arcane editor scripts to: $DEST_DIR"
echo "Dev launcher path written to: $UNITY_PROJECT/.arcane-dev-path"
echo ""
echo "In Unity: Settings > External Tools > select 'Arcane' from the dropdown."
