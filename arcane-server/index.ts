import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './src/types.ts';
import { authMiddleware } from './src/middleware/auth.ts';
import { chatRouter } from './src/routes/chat.ts';
import { embeddingsRouter } from './src/routes/embeddings.ts';
import { graphRouter } from './src/routes/graph.ts';
import { unityApiRouter } from './src/routes/unity-api.ts';
import { authRouter } from './src/routes/auth.ts';
import { authEmailRouter } from './src/routes/auth-email.ts';
import { authGoogleRouter } from './src/routes/auth-google.ts';
import { authEditorRouter } from './src/routes/auth-editor.ts';
import { usageRouter } from './src/routes/usage.ts';
import { adminRouter } from './src/routes/admin.ts';
import { feedbackRouter } from './src/routes/feedback.ts';

const app = new Hono<AppEnv>();

app.use('*', cors());

// Public routes
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', authRouter);
app.route('/', authEmailRouter);
app.route('/', authGoogleRouter);
app.route('/', authEditorRouter);
app.route('/', feedbackRouter);

// Protected routes (auth only — no budget/credit checks)
app.use('/v1/chat/*', authMiddleware());
app.use('/v1/embeddings', authMiddleware());
app.use('/v1/graph/*', authMiddleware());
// /v1/unity/* needs auth; /v1/admin/unity-api/* is guarded inside its router.
app.use('/v1/unity/*', authMiddleware());
app.route('/', chatRouter);
app.route('/', embeddingsRouter);
app.route('/', graphRouter);
app.route('/', unityApiRouter);

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
