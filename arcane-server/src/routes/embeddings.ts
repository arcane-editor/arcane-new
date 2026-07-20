import { Hono } from 'hono';
import { embedMany } from 'ai';
import type { AppEnv } from '../types.ts';
import type { AuthPayload } from '../middleware/auth.ts';
import { getHourlyCost } from '../lib/db.ts';
import { recordUsage } from '../lib/usage.ts';
import { workersAiProvider } from '../services/llm-router.ts';

export const embeddingsRouter = new Hono<AppEnv>();

const HOURLY_LIMIT_USD = 1.00;

// Cost-effective Workers AI embedding model (384-dim). Was OpenAI
// text-embedding-3-small @ 256-dim — note the dimension change for any
// downstream vector index.
const DEFAULT_EMBEDDING_MODEL = '@cf/baai/bge-small-en-v1.5';

interface EmbeddingRequest {
    input: string | string[];
    model?: string;
}

embeddingsRouter.post('/v1/embeddings', async (c) => {
    const user = c.get('user') as AuthPayload;

    // Check hourly spending limit
    const { totalCost, oldestTimestamp } = await getHourlyCost(c.env.arcane_db, parseInt(user.sub));
    if (totalCost >= HOURLY_LIMIT_USD) {
        let resetsAt: string;
        let resetsInSeconds: number;
        if (oldestTimestamp) {
            const resetTime = new Date(new Date(oldestTimestamp).getTime() + 60 * 60 * 1000);
            resetsAt = resetTime.toISOString();
            resetsInSeconds = Math.max(0, Math.ceil((resetTime.getTime() - Date.now()) / 1000));
        } else {
            resetsAt = new Date(Date.now() + 60 * 60 * 1000).toISOString();
            resetsInSeconds = 3600;
        }

        return c.json({
            error: `You've used all your credits. Resets in ~${Math.ceil(resetsInSeconds / 60)} minutes (${new Date(resetsAt).toLocaleTimeString()}).`,
        }, 429);
    }

    const body = await c.req.json<EmbeddingRequest>();

    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    const modelId = body.model ?? DEFAULT_EMBEDDING_MODEL;

    const startTime = Date.now();
    const model = workersAiProvider(c.env).textEmbedding(modelId);
    const { embeddings, usage } = await embedMany({ model, values: inputs });

    // Meter neuron spend (input-only; embeddings produce no output tokens).
    await recordUsage(c.env.arcane_db, parseInt(user.sub), modelId, usage?.tokens ?? 0, 0, Date.now() - startTime, { taskType: 'embeddings' });

    return c.json({
        object: 'list',
        data: embeddings.map((embedding, i) => ({
            object: 'embedding',
            index: i,
            embedding,
        })),
        model: modelId,
        usage: {
            prompt_tokens: usage?.tokens ?? 0,
            total_tokens: usage?.tokens ?? 0,
        },
    });
});
