#!/bin/bash
# Prepares the Arcane Unity extension for production / Asset Store deployment.
# Validates package structure, checks .meta files, cleans artifacts, and builds a UPM tarball.
# Usage: ./deploy-prod.sh

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

ERRORS=0

echo "=== Arcane Extension — Production Deploy ==="
echo ""

# --- 1. Validate required files ---
echo "Checking required files..."
REQUIRED_FILES=(
    "package.json"
    "LICENSE.md"
    "CHANGELOG.md"
    "Editor/Arcane.Editor.asmdef"
    "Documentation~/arcane-extension.md"
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
        --exclude='deploy-prod.sh' \
        --exclude='.arcane-dev-path' \
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

echo ""
echo "=== Deploy checklist ==="
echo "1. Import $TARBALL into a Unity 2021.3+ project"
echo "2. Install Asset Store Tools (com.unity.asset-store-tools)"
echo "3. Use Asset Store Tools > Package Upload to validate"
echo "4. Submit via publisher.unity.com"
