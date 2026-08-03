/**
 * Shared AI panel types: chat mode, effort level, attachment kinds.
 */

export type ChatMode = 'ask' | 'agent' | 'plan';

// Maps 1:1 to the server's `reasoningLevel` (low|mid|high|super). The backend
// alone decides which concrete model each level uses — the editor never sends a
// model id. 'super' is the "Extra High" tier.
export type Effort = 'low' | 'mid' | 'high' | 'super';

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
 * Context window per tier — must track arcane-server config/plans.ts
 * (`INTENSITY_CONFIG`) + services/llm-router.ts (`fallbackModelFor`) +
 * lib/costs.ts (`MODEL_CATALOG`).
 *
 * low/high/super route to EXTERNAL providers (MiniMax/Moonshot) that each
 * have a same-tier Workers AI fallback model (`fallbackModelFor`) the server
 * silently switches to on a provider outage; mid stays on the Workers AI
 * binding directly and has no fallback. Because a request can land on
 * EITHER the primary or the fallback model, the window recorded here must be
 * min(primary window, fallback window) — using the primary's larger window
 * would let compaction leave in more context than the fallback model can
 * actually accept, hard-failing the request the moment a tier fails over:
 *   low   → primary custom-minimax/MiniMax-M3 (200k),
 *           fallback @cf/qwen/qwen2.5-coder-32b-instruct (32k) → min = 32768
 *   mid   → @cf/zai-org/glm-5.2 (200k), no fallback             → 200000
 *   high  → primary custom-moonshot/kimi-k3 (256k),
 *           fallback @cf/zai-org/glm-5.2 (200k)                 → min = 200000
 *   super → alias of high                                       → min = 200000
 * Compaction previously assumed 32k for every tier, eliding context the big
 * models actually have room for.
 */
export const TIER_CONTEXT_WINDOWS: Record<Effort, number> = {
  low: 32768,
  mid: 200000,
  high: 200000,
  super: 200000,
};
