# Arcane Release Worker

Cloudflare Worker for uploading and serving Arcane editor release artifacts via R2 storage. Uses multipart upload to handle files exceeding Cloudflare's 100MB request body limit.

## Architecture

```
Client (upload.sh)          Worker                    R2 Bucket
  │                           │                         │
  ├── POST /mpu (create) ───►│── createMultipartUpload──►│
  │◄── { uploadId } ─────────│                          │
  │                           │                         │
  ├── PUT /mpu (part 1) ────►│── uploadPart(1, body) ──►│
  ├── PUT /mpu (part 2) ────►│── uploadPart(2, body) ──►│
  ├── ...                     │                         │
  ├── PUT /mpu (part N) ────►│── uploadPart(N, body) ──►│
  │                           │                         │
  ├── POST /mpu (complete) ──►│── complete(parts) ──────►│
  │◄── { key, etag } ────────│                          │
```

Files are split into ~95MB chunks locally, uploaded individually through the Worker, then assembled in R2 via multipart completion.

## Endpoints

| Method | Path | Auth | Description |
|--------|------|------|-------------|
| `POST` | `/mpu/:key` | API Key | Create multipart upload |
| `PUT` | `/mpu/:key` | API Key | Upload a part |
| `POST` | `/mpu/:key` | API Key | Complete multipart upload |
| `DELETE` | `/mpu/:key` | API Key | Abort multipart upload |
| `GET` | `/files/:key` | Public | Download a file |
| `GET` | `/list` | Public | List all files |
| `GET` | `/health` | Public | Health check |

**Worker URL:** `https://arcane-release-worker.sourav-das120699.workers.dev`

## Setup

### Prerequisites

- Node.js and npm
- Cloudflare account with Wrangler authenticated (`wrangler login`)
- R2 bucket `arcane-releases` already created

### Install & Deploy

```bash
cd arcane-release-worker
npm install
npx wrangler secret put UPLOAD_API_KEY    # set your upload API key
npx wrangler deploy
```

## Uploading Releases

### Using the upload script

```bash
cd arcane-release-worker

# Set your API key
export UPLOAD_API_KEY="your-api-key"

# Upload macOS installer
./scripts/upload.sh ../arcane-edior/electron-app/dist/Arcane.dmg v-0.10.1/Arcane.dmg

# Upload Windows installer
./scripts/upload.sh ../arcane-edior/electron-app/dist/ArcaneSetup.exe v-0.10.1/ArcaneSetup.exe
```

The version prefix (e.g. `v-0.10.1/`) is just the R2 key path — change it for each release:

```bash
# Next release
./scripts/upload.sh ../arcane-edior/electron-app/dist/Arcane.dmg v-0.11.0/Arcane.dmg
./scripts/upload.sh ../arcane-edior/electron-app/dist/ArcaneSetup.exe v-0.11.0/ArcaneSetup.exe
```

### Script environment variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `UPLOAD_API_KEY` | Yes | — | API key matching the Worker secret |
| `WORKER_URL` | No | `https://arcane-release-worker.sourav-das120699.workers.dev` | Worker URL override |

## Downloading Releases

Direct download links follow the pattern:

```
https://arcane-release-worker.sourav-das120699.workers.dev/files/<version>/<filename>
```

### v-0.10.1

- **macOS:** `https://arcane-release-worker.sourav-das120699.workers.dev/files/v-0.10.1/Arcane.dmg`
- **Windows:** `https://arcane-release-worker.sourav-das120699.workers.dev/files/v-0.10.1/ArcaneSetup.exe`

### List all releases

```bash
# All files
curl https://arcane-release-worker.sourav-das120699.workers.dev/list

# Filter by version
curl "https://arcane-release-worker.sourav-das120699.workers.dev/list?prefix=v-0.10.1"
```

## R2 Key Structure

```
arcane-releases/          ← R2 bucket
├── v-0.10.1/
│   ├── Arcane.dmg        ← macOS installer
│   └── ArcaneSetup.exe   ← Windows installer
├── v-0.11.0/
│   ├── Arcane.dmg
│   └── ArcaneSetup.exe
└── ...
```

## Configuration

**`wrangler.toml`** binds to the existing `arcane-releases` R2 bucket:

```toml
name = "arcane-release-worker"
main = "src/index.ts"
compatibility_date = "2025-12-01"
compatibility_flags = ["nodejs_compat"]

[[r2_buckets]]
binding = "RELEASES_BUCKET"
bucket_name = "arcane-releases"
```

### Secrets

Set via `npx wrangler secret put <NAME>`:

| Secret | Description |
|--------|-------------|
| `UPLOAD_API_KEY` | Required for all upload/delete operations |

## Limits

- **Part size:** 95MB (Cloudflare Workers free/pro plan limit is 100MB per request)
- **Max file size:** No practical limit — files are chunked into 95MB parts
- **Supported formats:** `.dmg`, `.exe`, `.AppImage` (served with correct MIME types)
