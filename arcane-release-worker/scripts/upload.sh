#!/bin/bash
set -euo pipefail

# ── Configuration ─────────────────────────────────────────────────────
WORKER_URL="${WORKER_URL:-https://arcane-release-worker.sourav-das120699.workers.dev}"
API_KEY="${UPLOAD_API_KEY:?Set UPLOAD_API_KEY environment variable}"
PART_SIZE=$((95 * 1024 * 1024))  # 95MB chunks (under 100MB Worker limit)

# ── Usage ─────────────────────────────────────────────────────────────
if [ $# -lt 2 ]; then
  echo "Usage: $0 <local-file> <r2-key>"
  echo "Example: $0 ../arcane-edior/electron-app/dist/Arcane.dmg v-0.10.1/Arcane.dmg"
  exit 1
fi

FILE="$1"
KEY="$2"

if [ ! -f "$FILE" ]; then
  echo "Error: File not found: $FILE"
  exit 1
fi

FILE_SIZE=$(stat -f%z "$FILE" 2>/dev/null || stat -c%s "$FILE" 2>/dev/null)
echo "Uploading: $FILE ($((FILE_SIZE / 1024 / 1024)) MB) → $KEY"

# ── Step 1: Create multipart upload ──────────────────────────────────
echo "Creating multipart upload..."
CREATE_RESPONSE=$(curl -sf -X POST \
  "${WORKER_URL}/mpu/${KEY}?action=mpu-create" \
  -H "X-API-Key: ${API_KEY}")

UPLOAD_ID=$(echo "$CREATE_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['uploadId'])")
echo "Upload ID: $UPLOAD_ID"

# ── Step 2: Split and upload parts ───────────────────────────────────
TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

split -b $PART_SIZE "$FILE" "${TMPDIR}/part_"

PARTS="[]"
PART_NUM=1
TOTAL_PARTS=$(ls "${TMPDIR}"/part_* | wc -l | tr -d ' ')

for PART_FILE in "${TMPDIR}"/part_*; do
  PART_FILE_SIZE=$(stat -f%z "$PART_FILE" 2>/dev/null || stat -c%s "$PART_FILE" 2>/dev/null)
  echo "Uploading part ${PART_NUM}/${TOTAL_PARTS} ($((PART_FILE_SIZE / 1024 / 1024)) MB)..."

  PART_RESPONSE=$(curl -sf -X PUT \
    "${WORKER_URL}/mpu/${KEY}?action=mpu-uploadpart&partNumber=${PART_NUM}&uploadId=${UPLOAD_ID}" \
    -H "X-API-Key: ${API_KEY}" \
    -H "Content-Type: application/octet-stream" \
    --data-binary @"${PART_FILE}")

  ETAG=$(echo "$PART_RESPONSE" | python3 -c "import sys,json; print(json.load(sys.stdin)['etag'])")
  PARTS=$(echo "$PARTS" | python3 -c "
import sys, json
parts = json.load(sys.stdin)
parts.append({'partNumber': ${PART_NUM}, 'etag': '${ETAG}'})
print(json.dumps(parts))
")

  echo "  Part ${PART_NUM} uploaded (etag: ${ETAG})"
  PART_NUM=$((PART_NUM + 1))
done

# ── Step 3: Complete multipart upload ────────────────────────────────
echo "Completing multipart upload..."
COMPLETE_BODY=$(python3 -c "import json; print(json.dumps({'parts': ${PARTS}}))")

COMPLETE_RESPONSE=$(curl -sf -X POST \
  "${WORKER_URL}/mpu/${KEY}?action=mpu-complete&uploadId=${UPLOAD_ID}" \
  -H "X-API-Key: ${API_KEY}" \
  -H "Content-Type: application/json" \
  -d "${COMPLETE_BODY}")

echo "Upload complete!"
echo "$COMPLETE_RESPONSE" | python3 -m json.tool
