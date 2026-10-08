import type { StackFrame, VariableNode } from '../stores/debug';
import type { CaptureMetadata, ProfilerCounter, ProfilerFrame, ProfilerSample } from './profiler';

/** Frozen, user-selected measurements. Never refreshed at AI send time. */
interface EvidenceOrigin {
  label: string;
  capturedAt: string;
  workspacePath: string | null;
}
export type UnityEvidence = EvidenceOrigin & ({
  source: 'debugger';
  data: {
    reason: string | null;
    thread?: { id: number; name: string };
    frames: StackFrame[];
    selectedFrame: number | null;
    variables: { name: string; values?: VariableNode[] }[];
    watches: [string, string][];
  };
} | {
  source: 'profiler';
  data: {
    metadata?: CaptureMetadata;
    frame?: ProfilerFrame;
    thread?: { id: number; name: string };
    sample: ProfilerSample | null;
    statistics: { count: number; median: number | null; p95: number | null; p99: number | null };
    counters?: ProfilerCounter[];
    topSamples: { name: string; selfMs: number; durationMs: number; calls: number; allocationBytes: number | null }[];
    hotspotRange?: { firstFrame: number | null | undefined; lastFrame: number | null | undefined; thread: number; search: string; complete: boolean };
    includedSamples: number;
    totalSamples?: number;
    droppedFrames?: number;
  };
});
