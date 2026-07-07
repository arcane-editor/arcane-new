import { describe, it, expect } from 'bun:test';
import { graphSnapshotBudget, capSnapshot } from './graph-snapshot-budget';

describe('graph snapshot budget', () => {
  it('gives high tiers 4096 chars and low tiers 1024', () => {
    expect(graphSnapshotBudget('low')).toBe(1024);
    expect(graphSnapshotBudget('mid')).toBe(1024);
    expect(graphSnapshotBudget('high')).toBe(4096);
    expect(graphSnapshotBudget('super')).toBe(4096);
  });

  it('caps text at the budget with an ellipsis', () => {
    const text = 'x'.repeat(5000);
    expect(capSnapshot(text, 1024).length).toBe(1024);
    expect(capSnapshot(text, 1024).endsWith('…')).toBe(true);
    expect(capSnapshot('short', 1024)).toBe('short');
  });
});
