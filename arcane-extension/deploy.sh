#!/bin/bash
# Builds a UPM tarball of the UnityIDE Unity extension.
# Validates package structure, checks .meta files, cleans artifacts, and packs.
#
# Usage: ./deploy.sh [release|dev]        (default: release)
#
# The package ships twice, once per release channel, because the two channels
# are separate applications: a different product name, deep-link scheme, config
# directory and updater feed. The checked-in source IS the release package;
# `dev` stages a copy and rewrites it (scripts/unity-extension-channel.mjs)
# before packing, so the source tree is never modified.

set -euo pipefail

CHANNEL="${1:-release}"
if [ "$CHANNEL" != "release" ] && [ "$CHANNEL" != "dev" ]; then
    echo "usage: $0 [release|dev]" >&2
    exit 2
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(dirname "$SCRIPT_DIR")"
cd "$SCRIPT_DIR"

# The dev variant is built from a staging copy so `arcane-extension/` keeps its
# release identity. The tarball is moved back here afterwards, so callers do not
# have to care which channel they asked for.
STAGING=""
if [ "$CHANNEL" = "dev" ]; then
    STAGING="$SCRIPT_DIR/.pack-dev"
    rm -rf "$STAGING"
    mkdir -p "$STAGING"
    # -a would carry .wrangler and any stale tarball; the deny list below and
    # .npmignore agree on what is not package content.
    tar -cf - --exclude='.pack-dev' --exclude='.wrangler' --exclude='*.tgz' \
              --exclude='.git' --exclude='.DS_Store' . | tar -xf - -C "$STAGING"
    node "$REPO_ROOT/scripts/unity-extension-channel.mjs" "$STAGING" dev
    cd "$STAGING"
fi

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

echo "=== UnityIDE Extension — $CHANNEL package ==="
echo ""

# --- 1. Validate required files ---
echo "Checking required files..."
REQUIRED_FILES=(
    "package.json"
    "LICENSE.md"
    "CHANGELOG.md"
    "Editor/UnityIDEChannel.cs"
    "Documentation~/unityide-extension.md"
)

for file in "${REQUIRED_FILES[@]}"; do
    if [ ! -f "$file" ]; then
        echo -e "  ${RED}MISSING${NC}: $file"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "  ${GREEN}OK${NC}: $file"
    fi
done

# --- 2. Check .meta files for all assets ---
echo ""
echo "Checking .meta files..."

# Check folders (skip Documentation~ — the ~ suffix makes it hidden to Unity, no meta needed)
for dir in Editor; do
    if [ -d "$dir" ] && [ ! -f "$dir.meta" ]; then
        echo -e "  ${RED}MISSING META${NC}: $dir.meta"
        ERRORS=$((ERRORS + 1))
    fi
done

# Check .cs and .asmdef files in Editor/
for file in Editor/*.cs Editor/*.asmdef; do
    if [ -f "$file" ] && [ ! -f "$file.meta" ]; then
        echo -e "  ${RED}MISSING META${NC}: $file.meta"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "  ${GREEN}OK${NC}: $file.meta"
    fi
done

# Check package.json meta
if [ ! -f "package.json.meta" ]; then
    echo -e "  ${RED}MISSING META${NC}: package.json.meta"
    ERRORS=$((ERRORS + 1))
else
    echo -e "  ${GREEN}OK${NC}: package.json.meta"
fi

# Check root .md files
for file in LICENSE.md CHANGELOG.md; do
    if [ -f "$file" ] && [ ! -f "$file.meta" ]; then
        echo -e "  ${RED}MISSING META${NC}: $file.meta"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "  ${GREEN}OK${NC}: $file.meta"
    fi
done

# --- 3. Validate package.json ---
echo ""
echo "Validating package.json..."

if ! command -v python3 &>/dev/null; then
    echo -e "  ${YELLOW}SKIP${NC}: python3 not found, skipping JSON validation"
else
    VERSION=$(python3 -c "import json; print(json.load(open('package.json'))['version'])" 2>/dev/null)
    NAME=$(python3 -c "import json; print(json.load(open('package.json'))['name'])" 2>/dev/null)
    DISPLAY=$(python3 -c "import json; print(json.load(open('package.json'))['displayName'])" 2>/dev/null)

    if [ -z "$VERSION" ] || [ -z "$NAME" ]; then
        echo -e "  ${RED}INVALID${NC}: package.json missing name or version"
        ERRORS=$((ERRORS + 1))
    else
        echo -e "  ${GREEN}OK${NC}: $NAME@$VERSION ($DISPLAY)"
    fi

    # Check recommended fields
    for field in documentationUrl changelogUrl licensesUrl author dependencies; do
        HAS=$(python3 -c "import json; d=json.load(open('package.json')); print('yes' if '$field' in d else 'no')" 2>/dev/null)
        if [ "$HAS" = "no" ]; then
            echo -e "  ${YELLOW}WARN${NC}: missing recommended field '$field'"
        fi
    done
fi

# --- 4. Clean dev artifacts ---
echo ""
echo "Cleaning build artifacts..."

find . -name ".DS_Store" -delete 2>/dev/null && echo -e "  ${GREEN}Removed${NC} .DS_Store files" || true
rm -f *.tgz 2>/dev/null && echo -e "  ${GREEN}Removed${NC} old .tgz files" || true

# --- 5. Abort if errors ---
if [ $ERRORS -gt 0 ]; then
    echo ""
    echo -e "${RED}FAILED: $ERRORS error(s) found. Fix them before deploying.${NC}"
    exit 1
fi

# --- 6. Build UPM tarball ---
echo ""
echo "Building UPM tarball..."

if command -v npm &>/dev/null; then
    npm pack --quiet 2>/dev/null
    TARBALL="${NAME}-${VERSION}.tgz"
    if [ -f "$TARBALL" ]; then
        echo -e "${GREEN}SUCCESS${NC}: Built $TARBALL"
    else
        # npm may use scoped name format
        TARBALL=$(ls -t *.tgz 2>/dev/null | head -1)
        if [ -n "$TARBALL" ]; then
            echo -e "${GREEN}SUCCESS${NC}: Built $TARBALL"
        else
            echo -e "${RED}FAILED${NC}: npm pack did not produce a tarball"
            exit 1
        fi
    fi
else
    # Fallback: manual tar (excludes dev files and hidden files)
    TARBALL="${NAME}-${VERSION}.tgz"
    tar czf "$TARBALL" \
        --exclude='.DS_Store' \
        --exclude='.gitignore' \
        --exclude='*.tgz' \
        --exclude='install-dev.sh' \
        --exclude='deploy.sh' \
        --exclude='.pack-dev' \
        --exclude='.unityide-dev-path' \
        package.json \
        LICENSE.md LICENSE.md.meta \
        CHANGELOG.md CHANGELOG.md.meta \
        Editor/ Editor.meta \
        Documentation~/ Documentation~.meta

    if [ -f "$TARBALL" ]; then
        echo -e "${GREEN}SUCCESS${NC}: Built $TARBALL"
    else
        echo -e "${RED}FAILED${NC}: tar did not produce a tarball"
        exit 1
    fi
fi

# The dev tarball was built in the staging copy; move it back so callers find
# it in the package directory either way.
if [ -n "$STAGING" ]; then
    mv "$TARBALL" "$SCRIPT_DIR/$TARBALL"
    cd "$SCRIPT_DIR"
    rm -rf "$STAGING"
fi

echo ""
if [ "$CHANNEL" = "dev" ]; then
    echo "=== Built the DEV-channel package ==="
    echo "It targets the \"UnityIDE Dev\" application and the unityide-dev:// scheme."
    echo "It must not be published to the release feed."
else
    echo "=== Deploy checklist ==="
    echo "1. Import $TARBALL into a Unity 2021.3+ project"
    echo "2. Install Asset Store Tools (com.unity.asset-store-tools)"
    echo "3. Use Asset Store Tools > Package Upload to validate"
    echo "4. Submit via publisher.unity.com"
fi
