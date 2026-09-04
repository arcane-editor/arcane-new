export type CheckSpec =
  | { type: 'file_exists'; path: string }
  | { type: 'file_contains'; path: string; pattern: string; flags?: string }
  | { type: 'file_not_contains'; path: string; pattern: string; flags?: string }
  | { type: 'analyzer_clean'; glob: string }
  | { type: 'answer_matches'; pattern: string; flags?: string }
  | { type: 'answer_not_matches'; pattern: string; flags?: string }
  // Asserts a tool (by its `AgentTool.name`, e.g. `unity_api_search`) was, or
  // was not, executed at least once during the run — see `TaskResult.toolCalls`.
  | { type: 'tool_called'; tool: string }
  | { type: 'tool_not_called'; tool: string };

export interface EvalTask {
  id: string;
  family: 'codegen' | 'grounding' | 'agentic' | 'plan';
  fixture: 'builtin-legacy' | 'urp-newinput' | 'urp2022-legacyinput' | 'builtin-legacy-ugui';
  mode: 'ask' | 'agent' | 'plan';
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
  /** Provider-cached share of inputTokens for this attempt (absent/0 when the provider reports none). */
  cachedInputTokens?: number;
  // Chronological list of every tool name actually executed during the run
  // (recorded on `tool_execution_start`, once per execution — see
  // `run-task.ts`). Backs the `tool_called`/`tool_not_called` checks.
  toolCalls: string[];
  error?: string;
  // Unity grounding tool (`unity_api_search`) cache misses against the
  // recorded fixtures — see `api-recordings.ts`. Always 0 in `--record` mode
  // (there's no cache to miss; every call is live).
  groundingCacheMisses: number;
  // Failures (`ok: false`) recorded during `--record` mode runs. Always 0 in
  // replay mode (misses don't count as failures). Surfaced alongside
  // `groundingCacheMisses` to signal recording quality issues (bad token,
  // server down, etc.) — see `api-recordings.ts` for warning logs.
  recordFailures: number;
  // Ask-mode grounding-linter (P2.2) revise cycles fired this task — 0 or 1
  // (exactly one forced revise turn max, same as production's agent-service
  // hook). When 1, `pass`/`checks` were graded against the SECOND (post-
  // revise) answer, not the model's first response — see `run-task.ts`.
  groundingLintHits: number;
}
