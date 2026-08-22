import { describe, it, expect } from 'bun:test';
import { includesTodoTool, nudgeEligible } from './todo-gates';

describe('includesTodoTool', () => {
  it('preplanning always includes it, any effort', () => {
    expect(includesTodoTool('preplanning', 'low')).toBe(true);
    expect(includesTodoTool('preplanning', 'mid')).toBe(true);
    expect(includesTodoTool('preplanning', 'high')).toBe(true);
  });

  it('plan-execution always includes it, any effort', () => {
    expect(includesTodoTool('plan-execution', 'low')).toBe(true);
    expect(includesTodoTool('plan-execution', 'mid')).toBe(true);
    expect(includesTodoTool('plan-execution', 'high')).toBe(true);
  });

  it('agent excludes it only at low (Standard = no todo machinery)', () => {
    expect(includesTodoTool('agent', 'low')).toBe(false);
    expect(includesTodoTool('agent', 'mid')).toBe(true);
    expect(includesTodoTool('agent', 'high')).toBe(true);
  });

  it('ask and plan-planning never include it (read-only, nothing to track)', () => {
    expect(includesTodoTool('ask', 'low')).toBe(false);
    expect(includesTodoTool('ask', 'high')).toBe(false);
    expect(includesTodoTool('plan-planning', 'low')).toBe(false);
    expect(includesTodoTool('plan-planning', 'high')).toBe(false);
  });
});

describe('nudgeEligible', () => {
  it('is false at low', () => {
    expect(nudgeEligible('low')).toBe(false);
  });

  it('is true at mid and high', () => {
    expect(nudgeEligible('mid')).toBe(true);
    expect(nudgeEligible('high')).toBe(true);
  });
});
