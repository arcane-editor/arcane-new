/** Protocol 5: authoring and playtesting. Queued acknowledgement is never proof. */
export type AutomationStatus = 'queued' | 'running' | 'passed' | 'failed' | 'cancelled' | 'interrupted' | 'unsupported';
export interface AuthoringAction {
  kind: 'object' | 'prefab' | 'component' | 'property' | 'savePrefab';
  /** Path relative to this operation's owned root, not an arbitrary scene. */
  target: string;
  parent?: string;
  primitive?: 'Cube' | 'Sphere' | 'Capsule' | 'Cylinder' | 'Plane' | 'Quad';
  assetPath?: string;
  component?: string;
  property?: string;
  value?: unknown;
  position?: { x: number; y: number; z: number };
  scale?: { x: number; y: number; z: number };
}
export interface AuthoringOperation {
  operationId: string;
  taskId: string;
  scenePath: string;
  ownedRoot: string;
  outputs: string[];
  actions: AuthoringAction[];
  builder?: { type: string; method: string; parameters: string };
  requireAuthoredLevel?: boolean;
  expectedAssetHashes?: Record<string, string | null>;
}
export interface GameplayStep {
  kind: 'input' | 'wait' | 'assert' | 'capture';
  device?: 'keyboard' | 'mouse' | 'gamepad' | 'touch';
  control?: string;
  value?: number | number[];
  frames?: number;
  seconds?: number;
  target?: string;
  component?: string;
  property?: string;
  comparison?: 'equals' | 'greater' | 'less' | 'exists';
  expected?: string | number | boolean;
  label?: string;
}
export interface GameplayScenario {
  id: string;
  scenePath: string;
  seed: number;
  timeoutSeconds?: number;
  steps: GameplayStep[];
}
export interface AutomationObservation {
  step: number;
  label: string;
  passed: boolean;
  actual?: string;
  expected?: string;
}
export interface AutomationCapture {
  label: string;
  mimeType: 'image/png';
  data: string;
}
export interface AutomationReport {
  operationId: string;
  taskId?: string;
  status: AutomationStatus;
  reason?: string;
  outputs?: string[];
  observations?: AutomationObservation[];
  captures?: AutomationCapture[];
  consoleErrors?: string[];
  scenePersistence?: boolean;
  elapsedSeconds?: number;
  cleanupComplete?: boolean;
  payloadHash?: string;
  performance?: { samples: number; meanFrameMs: number; maxFrameMs: number; peakMemoryMb: number; gcCollections: number };
}
