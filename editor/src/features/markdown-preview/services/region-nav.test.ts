import { describe, it, expect } from 'bun:test';
import { parsePlanDocument } from './plan-document';
import { planRegions } from './region-model';
import { resolveBoundary, type BoundaryInput } from './region-nav';

const PLAN = `# Add the inventory panel

## Todos
- [ ] T1 [easy] Wire the panel
- [ ] T2 [hard] Fill the slot grid

## Guide

### T1: Wire the panel
File: \`Assets/UI/InventoryPanel.uxml\`

### T2: Fill the slot grid
Apply the same conditional guard.

## Risks
Nothing structural.
`;

const REGIONS = planRegions(parsePlanDocument(PLAN));

function at(regionId: string, over: Partial<BoundaryInput> = {}): BoundaryInput {
  return {
    regions: REGIONS,
    regionId,
    key: 'Enter',
    collapsed: true,
    atStart: false,
    atEnd: false,
    atFirstLine: false,
    atLastLine: false,
    onEmptyTrailingLine: false,
    regionIsEmpty: false,
    stepIsEmpty: false,
    ...over,
  };
}

describe('resolveBoundary — Enter', () => {
  // The agreed rule: body text flows, and an empty line at the end is the
  // escape hatch that starts the next step.
  it('promotes an empty trailing line in a guide into a new step', () => {
    expect(
      resolveBoundary(at('step-0-guide', { key: 'Enter', atEnd: true, onEmptyTrailingLine: true })),
    ).toEqual({ kind: 'promote-step', afterStepIndex: 0 });
  });

  it('leaves Enter alone in the middle of a guide — that is just a new line', () => {
    expect(resolveBoundary(at('step-0-guide', { key: 'Enter' }))).toEqual({ kind: 'default' });
  });

  it('leaves Enter alone at the end of a guide whose last line has text', () => {
    expect(resolveBoundary(at('step-0-guide', { key: 'Enter', atEnd: true }))).toEqual({
      kind: 'default',
    });
  });

  it('does not promote from a prose block — only steps have a next step', () => {
    expect(
      resolveBoundary(at('prose-0', { key: 'Enter', atEnd: true, onEmptyTrailingLine: true })),
    ).toEqual({ kind: 'default' });
  });

  // A step title is one line by definition: the checkbox line it lives on.
  it('moves the caret into the guide instead of breaking a title in two', () => {
    expect(resolveBoundary(at('step-0-title', { key: 'Enter', atEnd: true }))).toEqual({
      kind: 'focus',
      regionId: 'step-0-guide',
      caret: 'start',
    });
  });

  it('consumes Enter in a title that has no guide to jump to', () => {
    const bare = planRegions(parsePlanDocument('## Todos\n- [ ] T1 [easy] Alone\n'));
    expect(
      resolveBoundary(at('step-0-title', { regions: bare, key: 'Enter', atEnd: true })),
    ).toEqual({ kind: 'consume' });
  });
});

describe('resolveBoundary — Backspace', () => {
  it('deletes a step when Backspace lands at the start of an empty one', () => {
    expect(
      resolveBoundary(
        at('step-1-title', { key: 'Backspace', atStart: true, regionIsEmpty: true, stepIsEmpty: true }),
      ),
    ).toEqual({ kind: 'remove-step', stepIndex: 1 });
  });

  it('refuses to delete a step that still has guide text under it', () => {
    expect(
      resolveBoundary(
        at('step-1-title', { key: 'Backspace', atStart: true, regionIsEmpty: true, stepIsEmpty: false }),
      ),
    ).toEqual({ kind: 'focus', regionId: 'step-0-guide', caret: 'end' });
  });

  // Merging a guide's prose up into a checkbox title is never what someone
  // means — the caret moves instead, and the text stays where it is.
  it('hands the caret to the title from the start of a guide, without merging text', () => {
    expect(resolveBoundary(at('step-1-guide', { key: 'Backspace', atStart: true }))).toEqual({
      kind: 'focus',
      regionId: 'step-1-title',
      caret: 'end',
    });
  });

  it('is an ordinary Backspace anywhere that is not the very start', () => {
    expect(resolveBoundary(at('step-1-guide', { key: 'Backspace' }))).toEqual({ kind: 'default' });
  });

  it('is an ordinary Backspace at the start of the first region — nothing to hand to', () => {
    expect(resolveBoundary(at('prose-0', { key: 'Backspace', atStart: true }))).toEqual({
      kind: 'default',
    });
  });
});

describe('resolveBoundary — arrows cross regions', () => {
  it('goes up out of the top line into the end of the region above', () => {
    expect(resolveBoundary(at('step-0-guide', { key: 'ArrowUp', atFirstLine: true }))).toEqual({
      kind: 'focus',
      regionId: 'step-0-title',
      caret: 'end',
    });
  });

  it('goes down out of the last line into the start of the region below', () => {
    expect(resolveBoundary(at('step-0-guide', { key: 'ArrowDown', atLastLine: true }))).toEqual({
      kind: 'focus',
      regionId: 'step-1-title',
      caret: 'start',
    });
  });

  it('stays put in the middle of a region', () => {
    expect(resolveBoundary(at('step-0-guide', { key: 'ArrowUp' }))).toEqual({ kind: 'default' });
    expect(resolveBoundary(at('step-0-guide', { key: 'ArrowDown' }))).toEqual({ kind: 'default' });
  });

  it('stays put at the two ends of the document', () => {
    expect(resolveBoundary(at('prose-0', { key: 'ArrowUp', atFirstLine: true }))).toEqual({
      kind: 'default',
    });
    expect(resolveBoundary(at('prose-1', { key: 'ArrowDown', atLastLine: true }))).toEqual({
      kind: 'default',
    });
  });
});

describe('resolveBoundary — guards', () => {
  // A selection means the key is editing the selection, not crossing an edge.
  it('never crosses a boundary while text is selected', () => {
    for (const key of ['Enter', 'Backspace', 'ArrowUp', 'ArrowDown'] as const) {
      expect(
        resolveBoundary(
          at('step-1-guide', {
            key,
            collapsed: false,
            atStart: true,
            atEnd: true,
            atFirstLine: true,
            atLastLine: true,
            onEmptyTrailingLine: true,
          }),
        ),
      ).toEqual({ kind: 'default' });
    }
  });

  it('falls back to default for a region id the document no longer has', () => {
    expect(
      resolveBoundary(at('step-9-guide', { key: 'ArrowUp', atFirstLine: true })),
    ).toEqual({ kind: 'default' });
  });
});
