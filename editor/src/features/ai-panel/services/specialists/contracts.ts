import type { AgentEvent, AgentMessage, AgentTool, StreamFn } from '../vendor/types';
import type { Effort } from '../types';

export type SpecialistRole = 'level-design' | 'ui-building' | 'editor-tooling' | 'gameplay' | 'presentation' | 'gameplay-verification' | 'independent-review';
export type EvidenceKind = 'compile' | 'scene-persistence' | 'gameplay' | 'visual-review' | 'review';
export type EvidenceStatus = 'passed' | 'failed' | 'not-run' | 'unsupported';
export interface VerificationEvidence {
  id: string;
  kind: EvidenceKind;
  status: EvidenceStatus;
  revision: number;
  summary: string;
  artifacts: string[];
  operationId?: string;
  scenarioId?: string;
  assertions?: { passed: number; total: number };
}
export interface SpecialistDefinition {
  role: SpecialistRole;
  label: string;
  instructions: string;
  readOnly: boolean;
  tools: readonly string[];
}
export interface SpecialistTask {
  id: string;
  role: SpecialistRole;
  objective: string;
  targets: string[];
  dependencies: string[];
  acceptanceCriteria: string[];
}
export interface SpecialistResult {
  id: string;
  role: SpecialistRole;
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  objective: string;
  summary: string;
  changedArtifacts: string[];
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  evidence: VerificationEvidence[];
  history?: AgentMessage[];
  activity?: string;
  assignment?: SpecialistTask;
  taskId?: string;
}
export interface SpecialistRunnerDeps {
  stream: (agentId: string, role: SpecialistRole | 'coordinator', onUsage: (input: number, output: number) => void) => StreamFn;
  tools: (task: SpecialistTask) => AgentTool[];
  context: (role: SpecialistRole) => string;
  onProgress: (result: SpecialistResult) => void;
  onEvent?: (agentId: string, event: AgentEvent) => void;
  effort: Effort;
  contextWindow: number;
}
