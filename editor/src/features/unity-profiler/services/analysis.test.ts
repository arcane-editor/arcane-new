import { describe, expect, test } from 'bun:test';
import { frameStatistics, aggregateSamples } from './analysis';
import type { ProfilerSample } from '../../../types/profiler';
describe('Unity profiling measurements', () => {
  test('reports missing statistics as unavailable, preserving real zero', () => {
    expect(frameStatistics([]).p95).toBeNull();
    expect(frameStatistics([{ frame: 1, durationMs: 0, gpuMs: null, threads: 1 }]).median).toBe(0);
  });
  test('uses nearest rank on unordered frames', () => {
    expect(frameStatistics([10, 1, 5, 2].map((durationMs, frame) => ({ durationMs, frame, gpuMs: null, threads: 1 }))).median).toBe(2);
  });
  test('sums self cost rather than pretending nested total cost is frame time', () => {
    const samples = [{ name: 'Update', selfMs: 2, durationMs: 10, allocationBytes: null }, { name: 'Update', selfMs: 3, durationMs: 9, allocationBytes: 32 }] as ProfilerSample[];
    expect(aggregateSamples(samples)[0]).toEqual({ name: 'Update', selfMs: 5, durationMs: 19, calls: 2, allocationBytes: 32 });
  });
});
