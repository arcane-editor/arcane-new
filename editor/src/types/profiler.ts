export interface ProfilerTarget { id: number; label: string }
export interface ProfilerCapabilities { unityVersion: string; cpu: boolean; gpuNote: string; targets: ProfilerTarget[]; selectedTarget: number }
export interface CaptureMetadata { id: string; target: string; project: string; capturedAt: string; unityVersion: string; deepProfiling: boolean; limitBytes: number }
export interface ProfilerStatus { captureId: string; recording: boolean; saving: boolean; metadata: CaptureMetadata; chunks: number[]; error: string; droppedFrames: number; bytes: number }
export interface ProfilerFrame { frame: number; durationMs: number; gpuMs: number | null; threads: number }
export interface ProfilerSource { path: string; line: number; method: string }
export interface ProfilerSample { id: number; parent: number; depth: number; name: string; startMs: number; durationMs: number; selfMs: number; category: number; allocationBytes: number | null; callstack: ProfilerSource[] }
export interface ProfilerCounter { name: string; value: number; unit: number; category: number }
export interface ProfilerQuery { samples: ProfilerSample[]; threads: { id: number; name: string }[]; counters: ProfilerCounter[]; total: number }
