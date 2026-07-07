export type CheckSpec =
  | { type: 'file_exists'; path: string }
  | { type: 'file_contains'; path: string; pattern: string; flags?: string }
  | { type: 'file_not_contains'; path: string; pattern: string; flags?: string }
  | { type: 'analyzer_clean'; glob: string }
  | { type: 'answer_matches'; pattern: string; flags?: string }
  | { type: 'answer_not_matches'; pattern: string; flags?: string };

export interface EvalTask {
  id: string;
  family: 'codegen' | 'grounding' | 'agentic';
  fixture: 'builtin-legacy' | 'urp-newinput';
  mode: 'ask' | 'agent';
  prompt: string;
  checks: CheckSpec[];
  maxTurns?: number; // default 12
}

export interface TaskResult {
  taskId: string;
  family: string;
  pass: boolean;
  checks: { spec: CheckSpec; pass: boolean; detail: string }[];
  turns: number;
  wallMs: number;
  inputTokens: number;
  outputTokens: number;
  error?: string;
}
