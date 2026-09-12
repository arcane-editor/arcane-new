import type { ProfilerFrame, ProfilerSample } from '../../../types/profiler';
export function frameStatistics(frames: ProfilerFrame[]) {
  const sorted = frames.map(f => f.durationMs).filter(n => Number.isFinite(n) && n >= 0).sort((a, b) => a - b);
  const percentile = (p: number) => sorted.length ? sorted[Math.ceil(p * sorted.length) - 1] : null;
  return { count: sorted.length, median: percentile(.5), p95: percentile(.95), p99: percentile(.99) };
}
export function aggregateSamples(samples: ProfilerSample[]) {
  const result = new Map<string, { name: string; selfMs: number; durationMs: number; calls: number; allocationBytes: number }>();
  for (const sample of samples) {
    const row = result.get(sample.name) ?? { name: sample.name, selfMs: 0, durationMs: 0, calls: 0, allocationBytes: 0 };
    row.selfMs += sample.selfMs; row.durationMs += sample.durationMs; row.calls++; row.allocationBytes += sample.allocationBytes ?? 0;
    result.set(sample.name, row);
  }
  return [...result.values()].sort((a, b) => b.selfMs - a.selfMs);
}
