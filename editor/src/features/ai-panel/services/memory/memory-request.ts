/**
 * Side-task lane request (spec §2/§4): one non-stream chat completion with
 * `taskType: 'memory'`, which the server routes to the cheap inline model
 * regardless of tier (arcane-server config/routing.ts). Used by the memory
 * distiller and consolidation passes — never by user-facing chat.
 */

import { useAuthStore } from '../../../../stores/auth';
import { API_URL } from '../../../../config/api';

const SIDE_TASK_TIMEOUT_MS = 30_000;

export async function sideTaskRequest(prompt: string): Promise<string> {
  const token = useAuthStore.getState().token;
  if (!token) throw new Error('not signed in');

  const res = await fetch(`${API_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: JSON.stringify({
      messages: [{ role: 'user', content: prompt }],
      stream: false,
      max_tokens: 800,
      metadata: { taskType: 'memory', reasoningLevel: 'low' },
    }),
    signal: AbortSignal.timeout(SIDE_TASK_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`side task HTTP ${res.status}`);
  const json = (await res.json()) as {
    choices?: Array<{ message?: { content?: string | null } }>;
  };
  return json.choices?.[0]?.message?.content ?? '';
}
