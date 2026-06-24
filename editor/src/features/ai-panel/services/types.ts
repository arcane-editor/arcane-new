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
