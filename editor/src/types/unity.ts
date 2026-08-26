// Unity protocol types — ported from unityide-ui/src/common/unity/unity-protocol.ts

export type UnityLogType = 'Log' | 'Warning' | 'Error' | 'Assert' | 'Exception';
export type UnityPlayMode = 'EditMode' | 'PlayMode';
export type UnityPlayState = 'Stopped' | 'Playing' | 'Paused';
export type UnityScriptingBackend = 'Mono' | 'IL2CPP';

export interface StackFrame {
  className: string;
  methodName: string;
  filePath: string;
  lineNumber: number;
}

export interface UnityLogEntry {
  message: string;
  stackTrace: string;
  logType: UnityLogType;
  timestamp: number;
  frameCount: number;
  mode: UnityPlayMode;
  parsedFrames?: StackFrame[];
}

export interface UnityProjectInfo {
  projectName: string;
  projectPath: string;
  unityVersion: string;
  companyName: string;
  productName: string;
  scriptingBackend: UnityScriptingBackend;
}

export interface PlaystateChangedPayload {
  state: UnityPlayState;
  isCompiling: boolean;
}

/** One compiler diagnostic forwarded from the Unity Editor bridge. */
export interface CompilerMessage {
  /** Project-relative (e.g. `Assets/Scripts/Foo.cs`) or absolute path. */
  file: string;
  /** 1-based line. */
  line: number;
  /** 1-based column (may be 0 from Unity). */
  column: number;
  message: string;
  type: 'Error' | 'Warning';
}

export interface CompilationPayload {
  started: boolean;
  success?: boolean;
  errors?: number;
  warnings?: number;
  /** Present on the `started:false` (finished) payload — the per-file diagnostics. */
  messages?: CompilerMessage[];
}

export interface OpenFilePayload {
  path: string;
  line: number;
  column: number;
}

/** One play-mode telemetry sample (F-4.5), emitted ≤4Hz while playing. */
export interface PlayModeStats {
  fps: number;
  frameTimeMs: number;
  totalMemoryMb: number;
  reservedMemoryMb: number;
  gcCollections: number;
  frameCount: number;
  drawCalls?: number;
}

export interface ConnectionChangedPayload {
  connected: boolean;
  info: UnityProjectInfo | null;
}

/**
 * The bridge package needs attention. `missing` = Unity is running but no
 * journal ever appeared; `outdated` = it handshook but is below the floor the
 * IDE requires (`unity_ipc.rs::MIN_PACKAGE_VERSION`).
 */
export interface StalePackagePayload {
  reason: 'missing' | 'outdated';
  installed: string | null;
  required: string;
}

// Stack trace parser — ported from unity-protocol.ts
const STACK_FRAME_REGEX = /(\S+)\.(\S+)\s*\(.*?\)\s*\(at\s+(.+):(\d+)\)/;

export function parseStackTrace(stackTrace: string): StackFrame[] {
  const frames: StackFrame[] = [];
  for (const line of stackTrace.split('\n')) {
    const match = STACK_FRAME_REGEX.exec(line.trim());
    if (match) {
      frames.push({
        className: match[1],
        methodName: match[2],
        filePath: match[3],
        lineNumber: parseInt(match[4], 10),
      });
    }
  }
  return frames;
}
