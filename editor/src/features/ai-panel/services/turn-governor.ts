/**
 * Turn governor (P3.2) — bounds the vendor agent loop from OUTSIDE, with NO
 * `vendor/` changes. The loop's only natural exit is a tool-free assistant
 * response (`agent-loop.ts:101`: `if (toolCalls.length === 0) break;`). This
 * module is a `StreamFn` decorator: once the wrapped stream has been called
 * `cap` times for the current SUBMIT (per-effort table below), every
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
 * SUBMIT SCOPE, not send scope: the cap is measured against one composer
 * submit, not one `agent.prompt()` send — some submits issue more than one
 * send and those sends must share a single budget rather than each getting
 * its own (preplanning issues two sends; planning + quality-repair issues
 * two sends). A submit is bracketed with `beginSubmitBudget()` /
 * `endSubmitBudget()`; while a submit is open, `resetTurnGovernor()` (called
 * between the chained sends, same call site as always) leaves the running
 * count and notice flags alone so the next send picks up where the last one
 * left off. A caller that never brackets a submit — every call site until
 * Task 3 wires the new controllers — gets exactly today's behavior:
 * `submitOpen` defaults to false, so the one `resetTurnGovernor()` per send
 * still zeroes the count every time, i.e. a fresh budget per send.
 * `extraCallsGranted` and `capReachedThisSend` are always per-send —
 * `resetTurnGovernor()` zeroes them unconditionally, submit or no submit.
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

/**
 * Per-effort LLM-call cap (P3.2). 100x the original 10/16/20 (2026-09-04
 * harness-resilience run): now that chained sends within one submit share a
 * single budget instead of each getting its own, the per-effort cap has to
 * cover the whole submit, not just one send.
 */
export const DEFAULT_TURN_CAPS: Record<Effort, number> = {
  low: 1000,
  mid: 1600,
  high: 2000,
};

/** Fraction of the cap at which the one-time-per-submit soft notice fires. */
export const SOFT_LIMIT_RATIO = 0.5;

export interface TurnGovernorConfig {
  /** Overrides the default per-effort cap table — tests, and the eval harness's fixed `task.maxTurns`. */
  caps?: Partial<Record<Effort, number>>;
  /**
   * Fires once per send when the cap is first reached. Defaults to pushing
   * an ai-store notice (dynamic import — see the module header; keeps this
   * file Bun-safe for the eval harness's direct import).
   */
  onCapReached?: (effort: Effort, cap: number) => void;
  /**
   * Fires on EVERY governed call, before the cap decision. `used` is the
   * submit-scoped count the cap is measured against — incremented before
   * this fires, so the governed call itself is included. No-op by default.
   */
  onProgress?: (used: number, cap: number, effort: Effort) => void;
  /**
   * Fires once per submit: the first call where `used` reaches
   * `Math.ceil(cap * SOFT_LIMIT_RATIO)` while still under the cap. Defaults
   * to the same dynamic-import ai-store notice pattern as `onCapReached`.
   */
  onSoftLimit?: (effort: Effort, used: number, cap: number) => void;
}

let submitCallCount = 0;
let noticeFired = false;
let softNoticeFired = false;
let extraCallsGranted = 0;
let submitOpen = false;
let capReachedThisSend = false;

/**
 * Reset the per-send state: call once per send (mirrors `resetCompileGate`).
 * `extraCallsGranted` and `capReachedThisSend` are always per-send and clear
 * unconditionally. `submitCallCount` and the two notice flags only clear
 * when no submit budget is open — see the module header's SUBMIT SCOPE note:
 * inside an open submit (`beginSubmitBudget()` … `endSubmitBudget()`), the
 * chained sends deliberately keep sharing one running count.
 */
export function resetTurnGovernor(): void {
  extraCallsGranted = 0;
  capReachedThisSend = false;
  if (!submitOpen) {
    submitCallCount = 0;
    noticeFired = false;
    softNoticeFired = false;
  }
}

/**
 * Open a submit-scoped budget shared by every send the current composer
 * submit issues (preplanning's two sends; planning + quality-repair's two
 * sends). Calling this while a submit is already open restarts it — as if
 * the previous submit's calls never happened.
 */
export function beginSubmitBudget(): void {
  submitCallCount = 0;
  noticeFired = false;
  softNoticeFired = false;
  submitOpen = true;
}

/** Close the current submit-scoped budget. Idempotent. */
export function endSubmitBudget(): void {
  submitOpen = false;
}

/** The submit-scoped call count the cap is currently measured against. */
export function getSubmitCallCount(): number {
  return submitCallCount;
}

/** Whether the cap was reached on the current send (cleared by `resetTurnGovernor`). */
export function wasCapReachedThisSend(): boolean {
  return capReachedThisSend;
}

/**
 * Grant extra calls for the current send only, so a closing pass can run a
 * second `agent.prompt` after the main send has exhausted the budget. The
 * grant is consumed by the next over-cap call and cleared by
 * `resetTurnGovernor`.
 *
 * **Intended callers** — both in agent-service.ts, both immediately before the
 * `agent.prompt` they are reserving for:
 *   - `runGroundingLint` (P2.2), 1 call for the ask-mode revise turn.
 *   - `runConsoleCheck` (Task 13), `CONSOLE_REPAIR_CALL_GRANT` calls for the
 *     post-turn console repair pass, which has real work to do (read, edit,
 *     re-run tests) rather than a single rewrite.
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

/** Soft-limit notice copy — fires once per submit at `SOFT_LIMIT_RATIO`, well before the model is cut off. */
export function softLimitNotice(used: number, cap: number): string {
  return `This task has used ${used} of its ${cap} model calls. It will wrap up on its own at the limit.`;
}

/** Cap-reached notice copy — fires once per send when the governed (tool-free wrap-up) path kicks in. */
export function capReachedNotice(cap: number): string {
  return `Reached the ${cap} model-call limit for this task and asked the agent to wrap up. Reply "continue" to pick up where it left off.`;
}

/**
 * Default notices: an ai-store system message, matching the wording the
 * agent-service's other in-loop notices use (e.g. the grounding linter's
 * `addSystemMessage` call). `stores/ai.ts` transitively touches `document`
 * (via the ai-panel barrel / theme store — see `hosted-stream.test.ts`'s
 * header comment), which is fatal under Bun — so both reach it via a dynamic
 * import, deferred until actually invoked. The eval harness (which DOES load
 * this module directly, for real, not just under test) always supplies its
 * own no-op `onCapReached`/`onSoftLimit`, so these defaults are never invoked
 * there and the import never fires.
 */
function defaultOnCapReached(_effort: Effort, cap: number): void {
  import('../../../stores/ai')
    .then(({ useAiStore }) => {
      useAiStore.getState().addSystemMessage(capReachedNotice(cap));
    })
    .catch(() => {
      // Best-effort notice only — never let this break the actual send.
    });
}

function defaultOnSoftLimit(_effort: Effort, used: number, cap: number): void {
  import('../../../stores/ai')
    .then(({ useAiStore }) => {
      useAiStore.getState().addSystemMessage(softLimitNotice(used, cap));
    })
    .catch(() => {
      // Best-effort notice only — never let this break the actual send.
    });
}

/** No-op default — most callers don't need progress; agent-service.ts wires a real one when Task 3 lands. */
function defaultOnProgress(): void {
  // Intentionally empty.
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
    submitCallCount++;
    const effort = normalizeEffort(options.reasoning);
    const config = getConfig();
    const cap = config.caps?.[effort] ?? DEFAULT_TURN_CAPS[effort];

    // Every call reports progress, including the governed one below —
    // `submitCallCount` is already incremented above.
    (config.onProgress ?? defaultOnProgress)(submitCallCount, cap, effort);

    // Soft notice: once per submit, the first call that crosses the ratio
    // while still under the cap.
    if (!softNoticeFired && submitCallCount >= Math.ceil(cap * SOFT_LIMIT_RATIO) && submitCallCount < cap) {
      softNoticeFired = true;
      (config.onSoftLimit ?? defaultOnSoftLimit)(effort, submitCallCount, cap);
    }

    // Below the cap, pass through untouched. At or beyond the cap, allow only
    // if an extra call has been granted (e.g., for grounding-lint revise).
    const exceedsNormalCap = submitCallCount >= cap;
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
    capReachedThisSend = true;
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
