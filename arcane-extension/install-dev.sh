#!/bin/bash
# DEV ONLY: Copies UnityIDE Editor scripts into a Unity project's Assets/Editor/UnityIDE/ folder
# and writes a dev config so Unity knows where to find the UnityIDE dev launcher.
# Usage: ./install-dev.sh [unity_project_path]
# Default: /Users/inno/My project

UNITY_PROJECT="${1:-/Users/inno/My project}"
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
SOURCE_DIR="$SCRIPT_DIR/Editor"
DEST_DIR="$UNITY_PROJECT/Assets/Editor/UnityIDE"
# Path to an executable that launches a dev build of the IDE. There is no such
# script in this repo, so it must be supplied. Before the rename this pointed at
# "$REPO_ROOT/arcane-edior/arcane-dev.sh" — a directory that has never existed
# (note the typo), which the C# side then silently skipped via File.Exists. The
# rename would have carried that dead path forward looking freshly correct, so
# it is now explicit and checked instead.
DEV_LAUNCHER="${UNITYIDE_DEV_LAUNCHER:-}"

if [ ! -d "$UNITY_PROJECT/Assets" ]; then
    echo "Error: '$UNITY_PROJECT' does not look like a Unity project (no Assets/ folder)."
    exit 1
fi

mkdir -p "$DEST_DIR"
cp "$SOURCE_DIR"/*.cs "$DEST_DIR/"

echo "Copied UnityIDE editor scripts to: $DEST_DIR"

# Write the dev config file so UnityIDEEditor.cs knows where the launcher is.
# Only when it actually points at something: the C# side skips a missing
# launcher without a word, so writing an unusable path just moves the failure
# somewhere harder to see.
if [ -n "$DEV_LAUNCHER" ] && [ -x "$DEV_LAUNCHER" ]; then
    echo "$DEV_LAUNCHER" > "$UNITY_PROJECT/.unityide-dev-path"
    echo "Dev launcher path written to: $UNITY_PROJECT/.unityide-dev-path"
elif [ -n "$DEV_LAUNCHER" ]; then
    echo "Warning: UNITYIDE_DEV_LAUNCHER='$DEV_LAUNCHER' is not an executable file."
    echo "         Skipped writing .unityide-dev-path; Unity will fall back to an installed build."
else
    echo "No dev launcher configured; Unity will use an installed UnityIDE build."
    echo "         Set UNITYIDE_DEV_LAUNCHER=/path/to/launcher to override."
fi

echo ""
echo "In Unity: Settings > External Tools > select 'UnityIDE' from the dropdown."
