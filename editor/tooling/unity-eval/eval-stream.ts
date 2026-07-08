/**
 * Non-streaming OpenAI-compatible StreamFn for the eval harness. Headless runs
 * don't need incremental deltas, so we do one POST per turn and emit a single
 * 'done' event carrying the finished assistant message.
 */

import { AssistantMessageEventStream } from '../../src/features/ai-panel/services/vendor/event-stream';
import { convertToOpenAI } from '../../src/features/ai-panel/services/openai-format';
import type {
  StreamFn,
  AssistantMessage,
} from '../../src/features/ai-panel/services/vendor/types';

export interface EvalModelConfig {
  baseUrl: string; // e.g. https://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/ai/v1
  apiKey: string;
  model: string;
  label: string;
  // Threaded into the request body as `metadata: { reasoningLevel }` so runs
  // against the arcane-server route pick the same model tier the server
  // would select for that effort level. Omitted (no `metadata` key at all)
  // when unset, since baselines against the raw CF OpenAI-compat endpoint
  // don't need or understand it.
  reasoningLevel?: string;
  // Hard cap per fetch attempt. Cloudflare Workers AI has, in practice, hung
  // for up to ~53 minutes with no response on a stuck request — without a
  // timeout that wedges the whole eval run. Default 3 minutes.
  requestTimeoutMs?: number;
  // Total attempts (including the first) before giving up and emitting an
  // 'error' event. Default 3.
  maxAttempts?: number;
  // Backoff is `retryBaseDelayMs * attempt` (linear: e.g. 20s, 40s at the
  // default). The observed rate limit is per-MINUTE, so short backoffs just
  // burn the next attempt on the same limit window. Default 20s; tests pass
  // a tiny value to stay fast.
  retryBaseDelayMs?: number;
}

export interface UsageTotals {
  input: number;
  output: number;
  requests: number;
}

interface OpenAIChatResponse {
  choices?: Array<{
    message?: {
      content?: string | null;
      tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }>;
    };
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function createEvalStreamFn(cfg: EvalModelConfig, usage: UsageTotals): StreamFn {
  return (context, options) => {
    const stream = new AssistantMessageEventStream();

    (async () => {
      const messages = convertToOpenAI(context.systemPrompt, context.messages);
      const tools = context.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));

      const requestTimeoutMs = cfg.requestTimeoutMs ?? 180_000;
      const maxAttempts = cfg.maxAttempts ?? 3;
      const retryBaseDelayMs = cfg.retryBaseDelayMs ?? 20_000;

      let json: OpenAIChatResponse | undefined;
      for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        // usage.requests counts real requests sent (cost money), so it's
        // incremented once per attempt regardless of outcome. Token usage is
        // only added below, from the eventual successful response.
        usage.requests++;

        const signals: AbortSignal[] = [AbortSignal.timeout(requestTimeoutMs)];
        if (options.signal) signals.push(options.signal);
        const signal = AbortSignal.any(signals);

        let res: Response;
        try {
          res = await fetch(`${cfg.baseUrl}/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
            body: JSON.stringify({
              model: cfg.model,
              messages,
              tools: tools.length > 0 ? tools : undefined,
              stream: false,
              max_tokens: 8192,
              ...(cfg.reasoningLevel ? { metadata: { reasoningLevel: cfg.reasoningLevel } } : {}),
            }),
            signal,
          });
        } catch (err) {
          // The caller aborted us (e.g. the agent hit maxTurns) — this isn't a
          // transient network failure, so don't burn a backoff sleep or a
          // retry attempt on it; propagate immediately so the real abort
          // reason isn't clobbered by a later "exhausted retries" error.
          if (options.signal?.aborted) throw err instanceof Error ? err : new Error(String(err));
          const reason = err instanceof Error ? err.message : String(err);
          if (attempt >= maxAttempts) throw err instanceof Error ? err : new Error(reason);
          const delay = retryBaseDelayMs * attempt;
          console.error(`[eval-stream] ${cfg.label} attempt ${attempt} failed (${reason}); retrying in ${delay}ms`);
          await sleep(delay);
          continue;
        }

        if (!res.ok) {
          const bodyText = await res.text();
          const transient = res.status === 429 || res.status >= 500;
          if (transient && attempt < maxAttempts) {
            const delay = retryBaseDelayMs * attempt;
            console.error(
              `[eval-stream] ${cfg.label} attempt ${attempt} failed (HTTP ${res.status}); retrying in ${delay}ms`,
            );
            await sleep(delay);
            continue;
          }
          throw new Error(`${cfg.label} HTTP ${res.status}: ${bodyText}`);
        }

        json = (await res.json()) as OpenAIChatResponse;
        break;
      }

      // Unreachable in practice: the loop above either returns a parsed
      // response or throws before exhausting attempts. Guards TypeScript's
      // control-flow analysis of `json`.
      if (!json) throw new Error(`${cfg.label}: exhausted retries with no response`);

      const msg = json.choices?.[0]?.message ?? {};
      usage.input += json.usage?.prompt_tokens ?? 0;
      usage.output += json.usage?.completion_tokens ?? 0;

      const content: AssistantMessage['content'] = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const tc of msg.tool_calls ?? []) {
        let args: Record<string, unknown> = {};
        try {
          args = JSON.parse(tc.function.arguments || '{}');
        } catch {
          // leave args empty; the tool will report the schema error back
        }
        content.push({ type: 'toolCall', id: tc.id, name: tc.function.name, arguments: args });
      }

      stream.push({ type: 'start' });
      stream.push({
        type: 'done',
        message: {
          role: 'assistant',
          content,
          stopReason: content.some((c) => c.type === 'toolCall') ? 'toolUse' : 'stop',
          timestamp: Date.now(),
        },
      });
    })().catch((err) => {
      stream.push({ type: 'error', error: err instanceof Error ? err : new Error(String(err)) });
    });

    return stream;
  };
}
