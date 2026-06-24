import { Hono } from 'hono';
import { createFeedback, findAllFeedback } from '../lib/db.ts';
import { authMiddleware } from '../middleware/auth.ts';
import type { AppEnv } from '../types.ts';

export const feedbackRouter = new Hono<AppEnv>();

// Public — anyone can submit feedback (no auth required)
feedbackRouter.post('/v1/feedback', async (c) => {
    const body = await c.req.json();
    const { rating, message, email, category } = body;

    if (!rating || typeof rating !== 'number' || rating < 1 || rating > 5) {
        return c.json({ error: 'Rating is required (1-5)' }, 400);
    }

    if (!message || typeof message !== 'string' || message.trim().length === 0) {
        return c.json({ error: 'Message is required' }, 400);
    }

    if (message.length > 5000) {
        return c.json({ error: 'Message too long (max 5000 characters)' }, 400);
    }

    const db = c.env.arcane_db;
    const feedback = await createFeedback(db, {
        rating,
        message: message.trim(),
        email: typeof email === 'string' ? email.trim() : undefined,
        category: typeof category === 'string' ? category : undefined,
    });

    return c.json({ success: true, id: feedback.id }, 201);
});

// Admin — list all feedback (protected)
feedbackRouter.get('/v1/feedback', authMiddleware(), async (c) => {
    const db = c.env.arcane_db;
    const feedback = await findAllFeedback(db);
    return c.json({ feedback });
});
