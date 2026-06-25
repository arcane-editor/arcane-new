import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { AppEnv } from './src/types.ts';
import { authMiddleware } from './src/middleware/auth.ts';
import { chatRouter } from './src/routes/chat.ts';
import { embeddingsRouter } from './src/routes/embeddings.ts';
import { graphRouter } from './src/routes/graph.ts';
import { unityApiRouter } from './src/routes/unity-api.ts';
import { authRouter } from './src/routes/auth.ts';
import { usageRouter } from './src/routes/usage.ts';
import { adminRouter } from './src/routes/admin.ts';
import { feedbackRouter } from './src/routes/feedback.ts';

const app = new Hono<AppEnv>();

app.use('*', cors());

// Public routes
app.get('/health', (c) => c.json({ status: 'ok' }));
app.route('/', authRouter);
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

export default app;
