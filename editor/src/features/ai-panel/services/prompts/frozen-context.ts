/**
 * Per-conversation frozen prompt decoration (cache activation §1).
 *
 * The volatile system-prompt tail (Unity facts, context pack, graph snapshot)
 * used to be rebuilt from live stores on every send. Because the system prompt
 * renders BEFORE all conversation history, any byte change there re-bills the
 * entire history at fresh-input rates on providers with prefix caching. This
 * module freezes those blocks the first time a conversation builds its prompt
 * and returns the identical strings for the conversation's lifetime.
 *
 * Mid-conversation drift (e.g. a graph rebuild) is surfaced at the TAIL of the
 * conversation instead — see `graphChangedSinceFreeze` and the one-line notice
 * `agent-service.ts` appends to the newest user message, which never
 * invalidates the cached prefix.
 *
 * Capture functions are injected by the caller (`prompts/index.ts`) so this
 * module stays store-free and Bun-safe for direct test imports.
 */

export interface FrozenBlocks {
  factsBlock: string | null;
  /** Reserved for the project context pack (spec §3); null until it ships. */
  contextPack: string | null;
  graphSnapshot: string | null;
}

/** Keep a few recent conversations so session switching doesn't thrash. */
const MAX_FROZEN_SESSIONS = 4;

const frozen = new Map<string, FrozenBlocks>();

/**
 * Return the frozen decoration blocks for a conversation, capturing them from
 * live sources on first use. A null/undefined sessionId (e.g. the service
 * constructor's placeholder prompt) is a passthrough — nothing is frozen.
 */
export function getFrozenDecoration(
  sessionId: string | null | undefined,
  capture: () => FrozenBlocks,
): FrozenBlocks {
  if (!sessionId) return capture();

  const existing = frozen.get(sessionId);
  if (existing) return existing;

  const blocks = capture();
  frozen.set(sessionId, blocks);
  if (frozen.size > MAX_FROZEN_SESSIONS) {
    // Maps iterate in insertion order — evict the oldest conversation.
    const oldest = frozen.keys().next().value;
    if (oldest !== undefined) frozen.delete(oldest);
  }
  return blocks;
}

/**
 * True when the conversation froze a graph snapshot and a freshly-built one
 * differs — i.e. the graph was rebuilt (or first appeared) since the freeze.
 * A currently-null snapshot never counts as changed (nothing useful to say).
 */
export function graphChangedSinceFreeze(
  sessionId: string | null | undefined,
  currentSnapshot: string | null,
): boolean {
  if (!sessionId || currentSnapshot == null) return false;
  const existing = frozen.get(sessionId);
  if (!existing) return false;
  return existing.graphSnapshot !== currentSnapshot;
}

/** Clear all frozen conversations (New Chat / workspace switch / dispose). */
export function resetFrozenDecoration(): void {
  frozen.clear();
}
