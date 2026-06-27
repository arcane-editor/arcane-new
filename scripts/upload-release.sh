#!/usr/bin/env bash
#
# Upload Arcane installers to the `arcane-releases` R2 bucket — the simple,
# manual counterpart to .github/workflows/release.yml. Useful for the macOS
# Apple-Silicon build you can produce locally (`cd editor && bun run tauri build`).
#
# Usage:
#   scripts/upload-release.sh <version> [dir]
#
#   <version>   e.g. v0.1.0 — used as the archive path prefix in R2.
#   [dir]       directory holding the installers (default: ./dist-release).
#
# Expected filenames in <dir> (whichever exist get uploaded):
#   Arcane-arm64.dmg   Arcane-x64.dmg   ArcaneSetup.exe
#
# Each file is uploaded to BOTH:
#   arcane-releases/<version>/<file>   (archived, immutable)
#   arcane-releases/latest/<file>      (stable link the landing page points at)
#
# Auth: either run `wrangler login` first, or export:
#   CLOUDFLARE_API_TOKEN   (token with R2 edit permission)
#   CLOUDFLARE_ACCOUNT_ID
#
# Note: `wrangler r2 object put` does a single-part upload (~300 MiB ceiling).
# Arcane installers are well under that. If a file ever exceeds it, switch that
# upload to the R2 S3 API via `rclone` or `aws s3 cp` (both do multipart).
set -euo pipefail

VERSION="${1:?usage: scripts/upload-release.sh <version> [dir]}"
DIR="${2:-dist-release}"
BUCKET="arcane-releases"
ASSETS=(Arcane-arm64.dmg Arcane-x64.dmg ArcaneSetup.exe)

uploaded=0
for asset in "${ASSETS[@]}"; do
  path="$DIR/$asset"
  if [[ ! -f "$path" ]]; then
    echo "skip  $asset (not found in $DIR)"
    continue
  fi
  echo "put   $BUCKET/$VERSION/$asset"
  bunx wrangler r2 object put "$BUCKET/$VERSION/$asset" --file "$path" --remote
  echo "put   $BUCKET/latest/$asset"
  bunx wrangler r2 object put "$BUCKET/latest/$asset" --file "$path" --remote
  uploaded=$((uploaded + 1))
done

if [[ "$uploaded" -eq 0 ]]; then
  echo "error: no installers found in $DIR" >&2
  exit 1
fi
echo "done: uploaded $uploaded installer(s) to $BUCKET ($VERSION + latest)"
