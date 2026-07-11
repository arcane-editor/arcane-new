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
 * Context window per tier — the real window of the model the server maps each
 * tier to (must track arcane-server config/plans.ts + lib/costs.ts):
 *   low   → @cf/qwen/qwen2.5-coder-32b-instruct (32k)
 *   mid   → @cf/moonshotai/kimi-k2.7-code       (256k)
 *   high  → @cf/zai-org/glm-5.2                 (200k)
 *   super → @cf/zai-org/glm-5.2                 (200k)
 * Compaction previously assumed 32k for every tier, eliding context the big
 * models actually have room for.
 */
export const TIER_CONTEXT_WINDOWS: Record<Effort, number> = {
  low: 32768,
  mid: 256000,
  high: 200000,
  super: 200000,
};
