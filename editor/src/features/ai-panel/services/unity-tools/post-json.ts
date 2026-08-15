// Bounded JSON POST — the one fetch shape every grounding call uses.
//
// Extracted from api-client.ts so the timeout behavior is directly
// Bun-testable (api-client's auth-store/unity-facts import chain is not), and
// so no grounding fetch can EVER run unbounded again: buildCompileHints issues
// up to nine of these sequentially inside the agent's tool loop, which has to
// stay responsive — a single hung request used to freeze the whole agent with
// no error, no retry, and a Stop button that couldn't reach it.

/** Per-request budget. Grounding is garnish; the tool loop must not wait on it. */
export const FETCH_TIMEOUT_MS = 10_000;

export type PostJsonResult =
  | { ok: true; json: unknown }
  | { ok: false; reason: 'offline' | `http-${number}` };

export async function postJsonWithTimeout(
  url: string,
  token: string,
  body: unknown,
  timeoutMs: number = FETCH_TIMEOUT_MS,
): Promise<PostJsonResult> {
  // Explicit controller + timer rather than `AbortSignal.timeout(...)`: an
  // inline timeout signal holds no strong reference after the fetch call and
  // Bun GCs it before the timer fires (verified: the abort never arrives),
  // so the bound would silently vanish in tests — and any runtime with the
  // same weak-timer behavior. The scope-held controller cannot be collected.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!res.ok) return { ok: false, reason: `http-${res.status}` };
    return { ok: true, json: await res.json() };
  } catch {
    // Network failure, timeout abort, or unparsable JSON — all degrade the
    // same way the callers already handle: grounding unavailable.
    return { ok: false, reason: 'offline' };
  } finally {
    clearTimeout(timer);
  }
}
