/**
 * Turn governor (P3.2) — bounds the vendor agent loop from OUTSIDE, with NO
 * `vendor/` changes. The loop's only natural exit is a tool-free assistant
 * response (`agent-loop.ts:101`: `if (toolCalls.length === 0) break;`). This
 * module is a `StreamFn` decorator: once the wrapped stream has been called
 * `cap` times for the current send (per-effort table below), every
 * subsequent call receives a MODIFIED COPY of the outgoing request —
 * `tool_choice: 'none'` attached via stream-extras (so the model cannot emit
 * a tool call, while the `tools` block itself stays byte-identical for the
 * provider's prompt-prefix cache) and a one-shot "wrap up" user-style
 * message appended — so the model's next response is naturally tool-free and
 * the loop exits on its own.
 *
 * Request-scoped only: the modified `Context` is a fresh object built here;
 * the caller's `context.messages` (backed by the agent's real history) is
 * never mutated, so the injected wrap-up message never reaches the
 * agent's message history or the chat UI — only this one outgoing request
 * sees it.
 *
 * Per-send state (call count, notice-fired flag) is module-level, reset via
 * `resetTurnGovernor()` — the same pattern `resetCompileGate()` /
 * `resetTurnTelemetry()` use. This mirrors those: `withTurnGovernor` wraps a
 * `StreamFn` ONCE (at Agent construction, in `agent-service.ts`'s
 * constructor), so a fresh per-send budget needs an explicit reset rather
 * than fresh closure state.
 *
 * Effort resolution: `StreamOptions.reasoning` already carries the effort
 * the agent was configured with for this send (`agent-service.ts` calls
 * `agent.setReasoning(opts.effort)` before `agent.prompt()`, and
 * `agent-loop.ts` threads that value into every `streamFn` call via
 * `config.reasoning`) — so the governor reads it directly from `options`
 * instead of needing a second, independently-synchronized copy of the
 * effort in its own config.
 */

import type { Context, Message, StreamFn, StreamOptions } from './vendor/types';
import type { Effort } from './types';
import { withStreamExtras } from './stream-extras';

const KNOWN_EFFORTS: readonly Effort[] = ['low', 'mid', 'high'];

/** Per-effort LLM-call cap (P3.2). */
export const DEFAULT_TURN_CAPS: Record<Effort, number> = {
  low: 10,
  mid: 16,
  high: 20,
};

export interface TurnGovernorConfig {
  /** Overrides the default per-effort cap table — tests, and the eval harness's fixed `task.maxTurns`. */
  caps?: Partial<Record<Effort, number>>;
  /**
   * Fires once per send when the cap is first reached. Defaults to pushing
   * an ai-store notice (dynamic import — see the module header; keeps this
   * file Bun-safe for the eval harness's direct import).
   */
  onCapReached?: (effort: Effort, cap: number) => void;
}

let callCount = 0;
let noticeFired = false;
let extraCallsGranted = 0;

/** Reset the per-send call count + notice flag. Call once per user send (mirrors `resetCompileGate`). */
export function resetTurnGovernor(): void {
  callCount = 0;
  noticeFired = false;
  extraCallsGranted = 0;
}

/**
 * Grant extra calls for the current send only. Used by grounding-lint's revise
 * turn (P2.2) to bypass the turn cap when running a second `agent.prompt` after
 * the main send has exhausted the budget. The grant is consumed by the next
 * over-cap call and cleared by `resetTurnGovernor`.
 *
 * **Single intended caller**: agent-service.ts `runGroundingLint`, immediately
 * before the revise `agent.prompt(buildReviseMessage(...))`.
 */
export function grantExtraCalls(n = 1): void {
  extraCallsGranted += n;
}

function normalizeEffort(reasoning: string | undefined): Effort {
  return (KNOWN_EFFORTS as readonly string[]).includes(reasoning ?? '')
    ? (reasoning as Effort)
    : 'mid';
}

// The reason MUST be named: at the cap tools are disabled via
// tool_choice:'none', and a model that only hears "stop using tools" invents
// its own explanation — real transcripts showed "I'm hitting an intermittent
// tool limitation where write becomes unavailable" followed by pasted file
// contents for the user to apply by hand. Name the cause, forbid the failure
// narrative, and point at the real recovery path (a follow-up message resumes
// with a fresh turn budget — and in plan mode, resumes the plan directly).
export const WRAP_UP_TEXT =
  "You have one response left: this send's turn limit was reached, so tools are disabled for this " +
  'final message only — they are not broken and will work again next send. Summarize what you did, ' +
  "what's verified, and what remains, then tell the user that replying 'continue' resumes the " +
  'remaining work. Do not paste file contents for manual use, and do not describe this as a tool ' +
  'limitation or failure.';

function wrapUpMessage(): Message {
  return { role: 'user', content: WRAP_UP_TEXT, timestamp: Date.now() };
}

/**
 * Default notice: an ai-store system message, matching the wording the
 * agent-service's other in-loop notices use (e.g. the grounding linter's
 * `addSystemMessage` call). `stores/ai.ts` transitively touches `document`
 * (via the ai-panel barrel / theme store — see `hosted-stream.test.ts`'s
 * header comment), which is fatal under Bun — so this reaches it via a
 * dynamic import, deferred until actually invoked. The eval harness (which
 * DOES load this module directly, for real, not just under test) always
 * supplies its own no-op `onCapReached`, so this default is never invoked
 * there and the import never fires.
 */
function defaultOnCapReached(effort: Effort): void {
  import('../../../stores/ai')
    .then(({ useAiStore }) => {
      useAiStore.getState().addSystemMessage(`Reached the ${effort} turn limit — asked the agent to wrap up`);
    })
    .catch(() => {
      // Best-effort notice only — never let this break the actual send.
    });
}

/**
 * Wrap a `StreamFn` with the turn governor. Composed ONCE — e.g.
 * `withTurnGovernor(hostedStream)` at Agent construction in
 * `agent-service.ts` — since per-send state lives at module scope (see
 * `resetTurnGovernor`).
 */
export function withTurnGovernor(
  streamFn: StreamFn,
  getConfig: () => TurnGovernorConfig = () => ({}),
): StreamFn {
  return (context: Context, options: StreamOptions) => {
    callCount++;
    const effort = normalizeEffort(options.reasoning);
    const config = getConfig();
    const cap = config.caps?.[effort] ?? DEFAULT_TURN_CAPS[effort];

    // Below the cap, pass through untouched. At or beyond the cap, allow only
    // if an extra call has been granted (e.g., for grounding-lint revise).
    const exceedsNormalCap = callCount >= cap;
    const canUseGrant = exceedsNormalCap && extraCallsGranted > 0;

    if (!exceedsNormalCap || canUseGrant) {
      if (canUseGrant) {
        extraCallsGranted--;
      }
      return streamFn(context, options);
    }

    // At the cap (and no extra grants), and defensively for any call beyond it
    // (shouldn't happen once stripping takes effect, but a model could
    // theoretically still try) — same treatment every time.
    if (!noticeFired) {
      noticeFired = true;
      (config.onCapReached ?? defaultOnCapReached)(effort, cap);
    }

    // Keep `tools` byte-identical (it heads the provider's cached prompt
    // prefix — stripping it re-bills the whole conversation) and force a
    // tool-free response via `tool_choice: 'none'` instead, carried as a
    // stream extra so vendor types stay untouched.
    const governedContext: Context = withStreamExtras(
      {
        ...context,
        messages: [...context.messages, wrapUpMessage()],
      },
      { toolChoice: 'none' },
    );
    return streamFn(governedContext, options);
  };
}
