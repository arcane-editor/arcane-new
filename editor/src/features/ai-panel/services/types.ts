/**
 * Shared AI panel types: chat mode, effort level, attachment kinds.
 */

export type ChatMode = 'ask' | 'agent' | 'plan';

// Maps 1:1 to the server's `reasoningLevel` (low|mid|high|super). The backend
// alone decides which concrete model each level uses — the editor never sends a
// model id. 'super' is the "Extra High" tier.
export type Effort = 'low' | 'mid' | 'high' | 'super';

/** Which agent backend the panel is currently talking to. */
export type AgentKind = 'arcane' | 'claude';

/**
 * Claude model selection. 'auto' lets Claude Code's own router pick.
 * The other values are family aliases that resolve to the latest in-family
 * model server-side, matching Claude Code's `--model` flag.
 */
export type ClaudeModel = 'auto' | 'opus' | 'sonnet' | 'haiku';

/**
 * Claude permission mode. Matches Claude Code's `--permission-mode` flag and
 * ACP's `session/set_mode`. `auto` and `dontAsk` are intentionally omitted from
 * v1 because they require plan-tier or pre-approved-tools setup.
 */
export type ClaudePermissionMode =
  | 'default'
  | 'acceptEdits'
  | 'plan'
  | 'bypassPermissions';

/**
 * Claude reasoning effort. Matches Claude Code's `--effort` flag. The Zed
 * screenshot shows 'Xhigh' as the active level — this is the literal value.
 */
export type ClaudeEffort = 'low' | 'medium' | 'high' | 'xhigh' | 'max';

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
