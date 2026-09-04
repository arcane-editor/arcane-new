// Unity protocol types — ported from unityide-ui/src/common/unity/unity-protocol.ts

export type UnityLogType =
  | 'Log'
  | 'Warning'
  | 'Error'
  | 'Assert'
  | 'Exception'
  | 'CompileError'
  | 'CompileWarning';
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
  /**
   * `'Unknown'` for a `getConsoleSnapshot`/`logEntries` row — LogEntries does
   * not record which mode a row was logged in, and the store must not guess
   * one (that used to silently turn every backfilled entry into `EditMode`).
   */
  mode: UnityPlayMode | 'Unknown';
  parsedFrames?: StackFrame[];
  /**
   * ALWAYS a client-side monotonic id, assigned by `stores/unity.ts` on
   * ingest for every entry — streamed or backfilled alike. Never taken
   * directly off the wire: a `getConsoleSnapshot` row's own `seq` is Unity's
   * console row index for a `logEntries`-sourced answer, a different and
   * incomparable numbering (see `unityRow`) — conflating the two is what let
   * `sinceTurnStart` filter against the wrong space entirely.
   */
  seq?: number;
  /**
   * Unity's own console row index for this entry, present only when it was
   * backfilled from a `source:"logEntries"` `getConsoleSnapshot` answer.
   * Informational only — never compared against `seq`, and never used for
   * `sinceTurnStart` filtering (Unity's row numbering has no notion of "this
   * turn").
   */
  unityRow?: number;
  /**
   * True for an entry `backfillConsoleHistory` pulled from Unity's own console
   * on connect — it happened before the IDE was streaming, not during this
   * session. Absent (not `false`) for everything that streamed live.
   */
  historical?: boolean;
}

export interface UnityProjectInfo {
  projectName: string;
  projectPath: string;
  unityVersion: string;
  companyName: string;
  productName: string;
  scriptingBackend: UnityScriptingBackend;
  /** Bridge wire-protocol version — absent on a pre-protocol-tracking package. */
  protocolVersion?: number;
}

/** One entry as returned by the `getConsoleSnapshot` bridge RPC. */
export interface ConsoleSnapshotEntry {
  seq: number;
  logType: UnityLogType;
  message: string;
  stackTrace: string;
  file: string;
  line: number;
  mode: UnityPlayMode | 'Unknown';
  /** How many consecutive times Unity collapsed this exact row (console `count`). */
  count: number;
}

/** Result of the `getConsoleSnapshot` bridge RPC. */
export interface ConsoleSnapshot {
  /** `"logEntries"` reads Unity's real console via reflection; `"hookRing"` is
   * this bridge's own capped memory, used when reflection is unavailable. */
  source: 'logEntries' | 'hookRing';
  epoch: number;
  total: number;
  offset: number;
  counts: { errors: number; warnings: number; logs: number };
  entries: ConsoleSnapshotEntry[];
  truncated: boolean;
  capabilities: {
    canClear: boolean;
    /** True only for `source: "logEntries"` — a hookRing answer only goes back
     * as far as this bridge session has been listening. */
    hasHistoryBeforeConnect: boolean;
  };
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
  /**
   * `Date.now()` when `stores/unity.ts` stored this as `lastCompilation` — NOT
   * part of the wire payload (Unity has no clock-sync reason to send one; the
   * IDE's own receipt time is what "N minutes ago" means to a caller of
   * `get_compile_errors`).
   */
  receivedAt?: number;
}

/** One failed test kept verbatim in a `test_run_completed` payload. */
export interface TestRunFailure {
  fullName: string;
  /** Usually `"Failed"` — carried verbatim from the C# `TestStatus` enum. */
  status: string;
  message: string;
  stackTrace: string;
  durationMs: number;
}

/**
 * A queued `runTests` run has actually finished. Mirrors `CompilationPayload`:
 * the `rpc_response` to a queued `runTests` only ever means "accepted", never
 * "done" — this is the real completion signal, and `stores/test-store.ts`
 * stores it verbatim as `lastRunCompleted`.
 */
export interface TestRunCompletedPayload {
  /** Null for a run an IDE older than this feature started (no runId sent). */
  runId: string | null;
  ok: boolean;
  /** Present only when `ok` is false. */
  reason?: 'test-framework-missing' | 'runner-unavailable';
  mode?: UnityPlayMode;
  total?: number;
  passed?: number;
  failed?: number;
  skipped?: number;
  inconclusive?: number;
  durationMs?: number;
  /** Capped at 50 — see `failuresTruncated`. */
  failures?: TestRunFailure[];
  /** True when more tests failed than `failures` kept verbatim. */
  failuresTruncated?: boolean;
}

export interface OpenFilePayload {
  path: string;
  /**
   * 1-based position to land on. Optional on the wire: a Unity package older
   * than the one that started sending them omits both, and "open the file" is
   * still the right thing to do without a position.
   */
  line?: number;
  column?: number;
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
