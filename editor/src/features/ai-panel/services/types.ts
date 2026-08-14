/**
 * Shared AI panel types: chat mode, effort level, attachment kinds.
 */

export type ChatMode = 'ask' | 'agent' | 'plan';

// Maps 1:1 to the server's `reasoningLevel` (low|mid|high). The backend
// alone decides which concrete model each level uses — the editor never sends a
// model id.
export type Effort = 'low' | 'mid' | 'high';

/**
 * Which agent backend the panel is talking to. Only 'arcane' remains — the
 * former local Claude Code / ACP-bridge agent was removed. Kept as a named
 * type (rather than inlining the literal) so persisted-session migration and
 * future external agents have a single place to widen.
 */
export type AgentKind = 'arcane';

/**
 * Coerce a persisted `agentKind` value (an arbitrary string read off disk —
 * older sessions carry now-removed kinds like `'claude'`) to a live
 * `AgentKind`. Anything that isn't a currently-supported kind falls back to
 * `'arcane'`, so old transcripts restore read-only and simply run as Arcane
 * rather than crashing the history list or restore path. Pure function.
 */
const KNOWN_AGENT_KINDS: readonly AgentKind[] = ['arcane'];

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
