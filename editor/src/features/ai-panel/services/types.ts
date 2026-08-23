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
      /**
       * A slab of text pasted into the composer, held as context instead of
       * burying the message you were writing. See `data/paste-chip.ts`.
       */
      kind: 'pasted-text';
      id: string;
      text: string;
      lineCount: number;
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
 * Usable context per tier, in tokens — the OFFLINE FALLBACK only.
 *
 * The runtime source of truth is the server-config store
 * (`stores/server-config.ts`'s `effectiveContextWindow`), which reads the
 * per-tier `contextWindow` published by `GET /v1/config`. That value is
 * already the per-tier MINIMUM across that tier's role models (planner /
 * executor / executorHard) in the server's merged model catalog — i.e. the
 * real economic/usable limit, not any one model's advertised window — so the
 * editor never has to reprice the cliff logic itself; it just uses the number
 * the server hands it. These constants below are what the editor falls back
 * to before the first successful `/v1/config` round-trip, and after one
 * fails, and mirror that same per-tier-minimum rule for today's lineup:
 *   low  → min(spark 131,072)                              = 131,072
 *   mid  → min(grok 500,000, spark 131,072)                 = 131,072
 *   high → min(sol 400,000, spark 131,072, grok 500,000)    = 131,072
 *
 * spark's 131k is a conservative seed window until the owner configures its
 * real context size — every tier is bottlenecked on it today, which is why
 * all three fallback values are currently identical. Update alongside
 * `stores/server-config.ts`'s `FALLBACK_CONTEXT_WINDOW`, which duplicates
 * these same three numbers (see that file's header for why it's a duplicate
 * rather than an import of this constant).
 */
export const TIER_CONTEXT_WINDOWS: Record<Effort, number> = {
  low: 131_072,
  mid: 131_072,
  high: 131_072,
};
