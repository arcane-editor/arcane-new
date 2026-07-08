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
  fixture: 'builtin-legacy' | 'urp-newinput' | 'urp2022-legacyinput';
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
  // Unity grounding tool (`unity_api_search`) cache misses against the
  // recorded fixtures — see `api-recordings.ts`. Always 0 in `--record` mode
  // (there's no cache to miss; every call is live).
  groundingCacheMisses: number;
  // Failures (`ok: false`) recorded during `--record` mode runs. Always 0 in
  // replay mode (misses don't count as failures). Surfaced alongside
  // `groundingCacheMisses` to signal recording quality issues (bad token,
  // server down, etc.) — see `api-recordings.ts` for warning logs.
  recordFailures: number;
}
