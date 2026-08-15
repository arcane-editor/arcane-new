import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './src/types.ts';
import { authMiddleware, requireVerifiedEmail } from './src/middleware/auth.ts';
import { rateLimit } from './src/middleware/rate-limit.ts';
import { chatRouter } from './src/routes/chat.ts';
import { embeddingsRouter } from './src/routes/embeddings.ts';
import { graphRouter } from './src/routes/graph.ts';
import { unityApiRouter } from './src/routes/unity-api.ts';
import { inlineRouter } from './src/routes/inline.ts';
import { authRouter } from './src/routes/auth.ts';
import { authEmailRouter } from './src/routes/auth-email.ts';
import { authGoogleRouter } from './src/routes/auth-google.ts';
import { authGithubRouter } from './src/routes/auth-github.ts';
import { authEditorRouter } from './src/routes/auth-editor.ts';
import { usageRouter } from './src/routes/usage.ts';
import { adminRouter } from './src/routes/admin.ts';
import { feedbackRouter } from './src/routes/feedback.ts';
import { billingRouter } from './src/routes/billing.ts';
import { billingWebhookRouter } from './src/routes/billing-webhook.ts';

const app = new Hono<AppEnv>();

// Browser origins that may call this API. Requests WITHOUT an Origin header
// (editor native fetch, curl, Google OAuth redirects) bypass CORS entirely —
// this list only governs what browsers may read cross-origin.
const ALLOWED_ORIGINS = [
    'https://arcaneai.org',
    'https://www.arcaneai.org',
    'https://dev.arcaneai.org',
    'http://localhost:4321',    // astro dev server
    'http://localhost:1420',    // tauri dev server
    'tauri://localhost',        // packaged app (macOS/Linux)
    'http://tauri.localhost',   // packaged app (Windows)
    'https://tauri.localhost',
];

app.use('*', cors({
    origin: (origin) => (ALLOWED_ORIGINS.includes(origin) ? origin : null),
    allowHeaders: ['Authorization', 'Content-Type'],
}));

// Auth rate limits (Cloudflare ratelimit bindings; fail open when absent).
const strict = rateLimit('RL_AUTH_STRICT');
for (const path of [
    '/v1/auth/signup', '/v1/auth/login', '/v1/auth/forgot', '/v1/auth/reset',
    '/v1/auth/verify', '/v1/auth/resend-verification', '/v1/auth/change-password',
    '/v1/auth/web/exchange', '/v1/auth/editor/exchange', '/v1/auth/google/start',
    '/v1/auth/github/start',
]) {
    app.use(path, strict);
}
// Editor sign-in attempt registration + the poll channel. Both are public and
// called repeatedly during a normal sign-in, so they belong on the poll
// limiter rather than the strict one.
const poll = rateLimit('RL_AUTH_POLL');
app.use('/v1/auth/editor/attempt', poll);
app.use('/v1/auth/editor/poll', poll);

// Public routes
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', authRouter);
app.route('/', authEmailRouter);
app.route('/', authGoogleRouter);
app.route('/', authGithubRouter);
app.route('/', authEditorRouter);
app.route('/', feedbackRouter);
// Billing: the webhook is PUBLIC (Dodo signs it, no user JWT) — mount it with
// the other public routers, before the AI auth gates. The billingRouter's own
// routes self-apply authMiddleware (except the public /v1/billing/plans).
app.route('/', billingWebhookRouter);
app.route('/', billingRouter);

// Protected routes (auth + verified email — AI endpoints only)
app.use('/v1/chat/*', authMiddleware(), requireVerifiedEmail());
app.use('/v1/embeddings', authMiddleware(), requireVerifiedEmail());
app.use('/v1/graph/*', authMiddleware(), requireVerifiedEmail());
// /v1/unity/* needs auth; /v1/admin/unity-api/* is guarded inside its router.
app.use('/v1/unity/*', authMiddleware(), requireVerifiedEmail());
app.use('/v1/completions/*', authMiddleware(), requireVerifiedEmail());
app.route('/', chatRouter);
app.route('/', embeddingsRouter);
app.route('/', graphRouter);
app.route('/', unityApiRouter);
app.route('/', inlineRouter);

// Protected routes (auth only)
app.route('/', usageRouter);

// Admin routes (auth + admin middleware applied inside adminRouter)
app.route('/', adminRouter);

// Catch-all for anything that escapes route-level try/catch (unexpected
// throws, middleware failures) — logs structured JSON and never leaks
// internal error details to the client.
app.onError((err, c) => {
    console.error(JSON.stringify({
        event: 'unhandled_error',
        path: c.req.path,
        message: err.message,
        stack: err.stack,
    }));
    return c.json({ error: { message: 'Internal error', type: 'server_error' } }, 500);
});

export default app;
