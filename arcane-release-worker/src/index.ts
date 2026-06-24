import { Hono } from 'hono';
import { cors } from 'hono/cors';

interface Env {
  RELEASES_BUCKET: R2Bucket;
  UPLOAD_API_KEY: string;
}

const app = new Hono<{ Bindings: Env }>();

app.use('*', cors());

// ── Auth middleware for upload endpoints ──────────────────────────────
function requireApiKey(c: any, next: () => Promise<void>) {
  const key = c.req.header('X-API-Key');
  if (!key || key !== c.env.UPLOAD_API_KEY) {
    return c.json({ error: 'Unauthorized' }, 401);
  }
  return next();
}

// ── Multipart Upload: Create ─────────────────────────────────────────
app.post('/mpu/*', requireApiKey, async (c) => {
  const key = c.req.path.replace('/mpu/', '');
  const action = c.req.query('action');

  if (action === 'mpu-create') {
    const mpu = await c.env.RELEASES_BUCKET.createMultipartUpload(key);
    return c.json({ key: mpu.key, uploadId: mpu.uploadId });
  }

  if (action === 'mpu-complete') {
    const uploadId = c.req.query('uploadId');
    if (!uploadId) return c.json({ error: 'uploadId required' }, 400);

    const body = await c.req.json<{ parts: { partNumber: number; etag: string }[] }>();
    const mpu = c.env.RELEASES_BUCKET.resumeMultipartUpload(key, uploadId);

    const uploaded = body.parts.map((p) => ({
      partNumber: p.partNumber,
      etag: p.etag,
    }));

    const object = await mpu.complete(uploaded);
    return c.json({
      key,
      etag: object.httpEtag,
    });
  }

  return c.json({ error: 'Invalid action. Use mpu-create or mpu-complete' }, 400);
});

// ── Multipart Upload: Upload Part ────────────────────────────────────
app.put('/mpu/*', requireApiKey, async (c) => {
  const key = c.req.path.replace('/mpu/', '');
  const action = c.req.query('action');

  if (action !== 'mpu-uploadpart') {
    return c.json({ error: 'Invalid action. Use mpu-uploadpart' }, 400);
  }

  const uploadId = c.req.query('uploadId');
  const partNumberStr = c.req.query('partNumber');
  if (!uploadId || !partNumberStr) {
    return c.json({ error: 'uploadId and partNumber required' }, 400);
  }

  const partNumber = parseInt(partNumberStr, 10);
  const mpu = c.env.RELEASES_BUCKET.resumeMultipartUpload(key, uploadId);
  const part = await mpu.uploadPart(partNumber, c.req.raw.body!);

  return c.json({ partNumber, etag: part.etag });
});

// ── Multipart Upload: Abort ──────────────────────────────────────────
app.delete('/mpu/*', requireApiKey, async (c) => {
  const key = c.req.path.replace('/mpu/', '');
  const uploadId = c.req.query('uploadId');
  if (!uploadId) return c.json({ error: 'uploadId required' }, 400);

  const mpu = c.env.RELEASES_BUCKET.resumeMultipartUpload(key, uploadId);
  await mpu.abort();
  return c.json({ success: true });
});

// ── Download a file ──────────────────────────────────────────────────
const CONTENT_TYPES: Record<string, string> = {
  '.dmg': 'application/x-apple-diskimage',
  '.exe': 'application/vnd.microsoft.portable-executable',
  '.AppImage': 'application/octet-stream',
  '.blockmap': 'application/octet-stream',
};

app.get('/files/*', async (c) => {
  const key = c.req.path.replace('/files/', '');

  if (!key || key === '') {
    // List all files
    const listed = await c.env.RELEASES_BUCKET.list();
    const files = listed.objects.map((obj) => ({
      key: obj.key,
      size: obj.size,
      uploaded: obj.uploaded.toISOString(),
    }));
    return c.json({ files });
  }

  const object = await c.env.RELEASES_BUCKET.get(key);
  if (!object) {
    return c.json({ error: 'File not found' }, 404);
  }

  const ext = key.substring(key.lastIndexOf('.'));
  const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';
  const filename = key.split('/').pop() ?? key;

  return new Response(object.body, {
    headers: {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
      'Content-Length': String(object.size),
      'Cache-Control': 'public, max-age=86400',
    },
  });
});

// ── List all files ───────────────────────────────────────────────────
app.get('/list', async (c) => {
  const prefix = c.req.query('prefix') ?? undefined;
  const listed = await c.env.RELEASES_BUCKET.list({ prefix });
  const files = listed.objects.map((obj) => ({
    key: obj.key,
    size: obj.size,
    uploaded: obj.uploaded.toISOString(),
  }));
  return c.json({ files });
});

// ── Health ───────────────────────────────────────────────────────────
app.get('/health', (c) => c.json({ status: 'ok' }));

export default app;
