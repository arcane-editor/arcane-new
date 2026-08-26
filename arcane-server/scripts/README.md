# Unity API grounding — corpus build & ingest pipeline

This pipeline populates the **version-accurate Unity API grounding** that the
editor's AI agent uses to stop hallucinating Unity APIs. It writes to two stores
on Cloudflare:

- **D1** (`unity_api_signatures`) — exact, deterministic signature lookup. Powers
  the compile-gate's `CS1061`/`CS0117`/`CS1501` repair and `POST /v1/unity/api/lookup`.
- **Vectorize** (`unity-docs-v1`, 384-dim bge-small) — semantic search over the
  **entire** ScriptReference + Manual + API surface. Powers `POST /v1/unity/api/search`.

Everything is **per Unity version** and filtered by version (+ render pipeline /
input system) at query time.

## One-time index setup

```bash
wrangler vectorize create unity-docs-v1 --dimensions=384 --metric=cosine
wrangler vectorize create-metadata-index unity-docs-v1 --property-name unityVersion   --type string
wrangler vectorize create-metadata-index unity-docs-v1 --property-name docType         --type string
wrangler vectorize create-metadata-index unity-docs-v1 --property-name renderPipeline  --type string
wrangler vectorize create-metadata-index unity-docs-v1 --property-name inputSystem     --type string
wrangler vectorize create-metadata-index unity-docs-v1 --property-name deprecated      --type string

# D1 table:
wrangler d1 execute arcane-db --remote --file=migrations/0009_unity_api_signatures.sql
```

## Build the corpus for a version (e.g. 6000.0)

**1. Exact signatures — reflect over the Unity managed DLLs** (needs the .NET SDK):

```bash
dotnet run --project scripts/unity-api-extractor -- \
  --managed "/Applications/Unity/Hub/Editor/6000.0.30f1/Unity.app/Contents/Managed" \
  --version 6000.0 \
  --out ./out/api-6000.0.json
# Optionally pass extra --managed dirs (e.g. a project's Library/ScriptAssemblies)
# to also cover installed-package APIs.
```

**2. Documentation prose — parse the offline docs bundle** (ScriptReference + Manual):

```bash
node scripts/parse-unity-docs.mjs \
  --docs-root "/path/to/UnityDocumentation/en" \
  --version 6000.0 \
  --out ./out/docs-6000.0.jsonl
```

Get the offline docs from Unity Hub (per-version "Documentation" download) or
mirror `docs.unity3d.com/6000.0/Documentation/`. Point `--docs-root` at the
`.../Documentation/en` dir (it contains `ScriptReference/` and `Manual/`).

**3. Ingest — one-time, direct to Vectorize + D1 (NO Worker route):**

`scripts/ingest-direct.mjs` writes straight to Cloudflare via the REST API,
reusing your existing `wrangler login` (it reads the OAuth token from
`~/Library/Preferences/.wrangler/config/default.toml`). No app account, no admin
role, no ingest endpoint on the Worker.

```bash
node scripts/ingest-direct.mjs \
  --version 6000.3 \
  --api ./out/api-6000.3.json \
  --reset            # clear D1 rows for this version first (optional)
# Resumable: re-run with --resume after an interruption.
# Override defaults with --account <id> --d1 <db-uuid> --index <name> if needed.
```

It embeds with `@cf/baai/bge-small-en-v1.5` (same model the search route uses at
query time), upserts vectors to Vectorize, and inserts signatures into D1, in
resumable batches with deterministic ids (re-runs overwrite, never duplicate).

> OAuth tokens last ~1h. If a long run 401s, run any `npx wrangler` command to
> refresh, then re-run with `--resume`. Vectorize upserts are eventually-
> consistent — allow a few minutes after a large ingest before querying.

## Verify

```bash
# exact (no model cost)
curl -sX POST $UNITYIDE_SERVER_URL/v1/unity/api/lookup -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"unityVersion":"6000.0","type":"Rigidbody","member":"AddForce"}' | jq

# semantic
curl -sX POST $UNITYIDE_SERVER_URL/v1/unity/api/search -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"unityVersion":"6000.0","query":"apply force at a point"}' | jq
```

Repeat steps 1–3 for each Unity version you want to support.
