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

export function createEvalStreamFn(cfg: EvalModelConfig, usage: UsageTotals): StreamFn {
  return (context, options) => {
    const stream = new AssistantMessageEventStream();

    (async () => {
      const messages = convertToOpenAI(context.systemPrompt, context.messages);
      const tools = context.tools.map((t) => ({
        type: 'function' as const,
        function: { name: t.name, description: t.description, parameters: t.parameters },
      }));

      const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
        body: JSON.stringify({
          model: cfg.model,
          messages,
          tools: tools.length > 0 ? tools : undefined,
          stream: false,
          max_tokens: 8192,
        }),
        signal: options.signal,
      });
      if (!res.ok) throw new Error(`${cfg.label} HTTP ${res.status}: ${await res.text()}`);

      const json = (await res.json()) as OpenAIChatResponse;
      const msg = json.choices?.[0]?.message ?? {};
      usage.input += json.usage?.prompt_tokens ?? 0;
      usage.output += json.usage?.completion_tokens ?? 0;
      usage.requests++;

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
