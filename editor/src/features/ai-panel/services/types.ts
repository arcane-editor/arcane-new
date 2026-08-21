/**
 * Shared AI panel types: chat mode, effort level, attachment kinds.
 */

export type ChatMode = 'ask' | 'agent' | 'plan';

// Maps 1:1 to the server's `reasoningLevel` (low|mid|high). The backend
// alone decides which concrete model each level uses — the editor never sends a
// model id.
export type Effort = 'low' | 'mid' | 'high';

/**
 * Which agent backend the panel is talking to.
 *
 * - `'arcane'` — the hosted Arcane agent (the default, and the only one a free
 *   plan can use).
 * - `'claude'` — Claude Code, driven locally over the Agent Client Protocol.
 *   Paid plans only; see `external-agent-gate.ts`.
 *
 * Widening this type is the single place a new external agent is registered:
 * add the literal here, add it to `KNOWN_AGENT_KINDS` below, and give it a row
 * in `AgentPicker`.
 */
export type AgentKind = 'arcane' | 'claude';

/** Every agent kind except the built-in hosted one. */
export type ExternalAgentKind = Exclude<AgentKind, 'arcane'>;

export function isExternalAgent(kind: AgentKind): kind is ExternalAgentKind {
  return kind !== 'arcane';
}

/**
 * Coerce a persisted `agentKind` value (an arbitrary string read off disk) to
 * a live `AgentKind`. Anything that isn't a currently-supported kind falls
 * back to `'arcane'`, so a session written by a newer build (or a corrupted
 * one) restores read-only as Arcane rather than crashing the history list or
 * restore path. Pure function.
 *
 * NOTE: `'claude'` now round-trips. Entitlement is deliberately NOT checked
 * here — a restored Claude transcript must still render for a user whose plan
 * lapsed; the composer is what locks. Coercing on plan would silently rewrite
 * history and mislabel whose turns those were.
 */
const KNOWN_AGENT_KINDS: readonly AgentKind[] = ['arcane', 'claude'];

export function coerceAgentKind(value: unknown): AgentKind {
  return KNOWN_AGENT_KINDS.includes(value as AgentKind) ? (value as AgentKind) : 'arcane';
}

/**
 * Coerce a persisted `effort` value (an arbitrary string read off disk) to a
 * live `Effort`. Older sessions may carry a now-removed level (e.g. the
 * former `'super'` tier) or `'high'` from before Free-tier gating existed;
 * anything that isn't a currently-supported level falls back to `'low'` —
 * the server's own `DEFAULT_INTENSITY` and the only level every plan can
 * use. Pure function.
 */
const KNOWN_EFFORTS: readonly Effort[] = ['low', 'mid', 'high'];

export function coerceEffort(value: unknown): Effort {
  return KNOWN_EFFORTS.includes(value as Effort) ? (value as Effort) : 'low';
}

export type Attachment =
  | {
      kind: 'file';
      id: string;
      path: string;
      relPath: string;
      bytes: number;
    }
  | {
      kind: 'image';
      id: string;
      dataUrl: string;
      mimeType: string;
      sourceLabel: string;
    }
  | {
      kind: 'unity-doc';
      id: string;
      name: string;
      url: string;
      category?: string;
    }
  | {
      /** Live Unity context resolved at send time. */
      kind: 'unity-context';
      id: string;
      verb: 'scene' | 'selection' | 'hierarchy' | 'console';
    }
  | {
      /** A specific live GameObject, resolved at send time. */
      kind: 'unity-object';
      id: string;
      name: string;
      instanceId?: number;
    }
  | {
      /** A Unity asset (scene/prefab/material/etc.) from the GUID index, resolved at send time. */
      kind: 'unity-asset';
      id: string;
      guid: string;
      path: string;
      relPath: string;
    };

/**
 * Usable context per tier, in tokens.
 *
 * These are PRICING cliffs, not model windows. Two of the three models reprice
 * the ENTIRE request once input crosses a threshold — a 200,001-token Max
 * request costs double a 200,000-token one — so the economic limit is lower
 * than the model's advertised window and compaction must respect it:
 *   low  → openai/gpt-5.6-luna, window 1,050,000, reprices above 272,000
 *   mid  → @cf/zai-org/glm-5.2, window 262,144, FLAT pricing (no cliff)
 *   high → xai/grok-4.6,        window 500,000,   reprices above 200,000
 *
 * Note Max has the SMALLEST usable window. Deep Think is the correct tier for
 * genuinely large-context work despite sitting lower on the ladder.
 */
export const TIER_CONTEXT_WINDOWS: Record<Effort, number> = {
  low: 272_000,
  mid: 262_144,
  high: 200_000,
};
