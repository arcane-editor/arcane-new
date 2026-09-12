import { describe, it, expect } from 'bun:test';
import { MODES, MODE_LADDER, DESIGN_MODE, modeOptionFor } from './modes';

describe('the pickable modes', () => {
  it('offers exactly Ask, Agent and Plan', () => {
    expect(MODES.map((m) => m.value)).toEqual(['ask', 'agent', 'plan']);
  });

  it('keeps Agent at index 1, which the selector falls back to by position', () => {
    expect(MODES[1].value).toBe('agent');
  });

  it('never offers Design — it has no meaning without a document on the canvas', () => {
    expect(MODES.some((m) => m.value === 'design')).toBe(false);
    expect(MODE_LADDER.some((m) => m.value === 'design')).toBe(false);
  });
});

describe('modeOptionFor — what the sidebar renders', () => {
  it('renders each real mode as itself', () => {
    for (const mode of MODES) expect(modeOptionFor(mode.value)).toBe(mode);
  });

  it('renders a design thread as Agent, so the sidebar never advertises Design', () => {
    // The design chat belongs to the canvas dock. `ChatInput` keeps this
    // honest by actually leaving design mode when you send from the sidebar.
    expect(modeOptionFor('design').value).toBe('agent');
  });

  it('still describes Design somewhere, because it is a real ChatMode', () => {
    expect(DESIGN_MODE.value).toBe('design');
    expect(DESIGN_MODE.label).toBe('Design');
  });
});
