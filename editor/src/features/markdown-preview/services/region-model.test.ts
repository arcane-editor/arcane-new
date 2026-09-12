import { describe, it, expect } from 'bun:test';
import { parsePlanDocument } from './plan-document';
import { planRegions, regionsInOrder } from './region-model';

const PLAN = `# Add the inventory panel

## Todos
- [ ] T1 [easy] Wire the panel
- [x] T2 [hard] Fill the slot grid

## Guide

### T1: Wire the panel
File: \`Assets/UI/InventoryPanel.uxml\`

### T2: Fill the slot grid
Apply the same conditional guard.

## Risks
Nothing structural.
`;

describe('planRegions', () => {
  it('returns every editable span of a structured plan in document order', () => {
    const regions = planRegions(parsePlanDocument(PLAN));

    expect(regions.map((r) => `${r.kind}:${r.id}`)).toEqual([
      'prose:prose-0',
      'title:step-0-title',
      'guide:step-0-guide',
      'title:step-1-title',
      'guide:step-1-guide',
      'prose:prose-1',
    ]);
  });

  it('carries ranges that slice back to exactly what the user edits', () => {
    const byId = new Map(planRegions(parsePlanDocument(PLAN)).map((r) => [r.id, r]));
    const slice = (id: string) => {
      const r = byId.get(id)!;
      return PLAN.slice(r.range.start, r.range.end).trim();
    };

    // The title range excludes `T1` and `[easy]` — the executor routes on both.
    expect(slice('step-0-title')).toBe('Wire the panel');
    // The guide range excludes its own `### T1:` heading.
    expect(slice('step-0-guide')).toBe('File: `Assets/UI/InventoryPanel.uxml`');
    expect(slice('step-1-guide')).toBe('Apply the same conditional guard.');
    expect(slice('prose-1')).toContain('Nothing structural.');
  });

  it('names the step a title/guide belongs to, and nothing else', () => {
    const regions = planRegions(parsePlanDocument(PLAN));
    expect(regions.find((r) => r.id === 'step-1-guide')?.stepIndex).toBe(1);
    expect(regions.find((r) => r.id === 'prose-0')?.stepIndex).toBeNull();
  });

  it('skips the guide region for a step that has no guide entry', () => {
    const bare = '# T\n\n## Todos\n- [ ] T1 [easy] Only a todo\n';
    // `prose-0` is the `# T` line above the checklist — the point here is that
    // no `step-0-guide` appears.
    expect(planRegions(parsePlanDocument(bare)).map((r) => r.id)).toEqual(['prose-0', 'step-0-title']);
  });

  it('treats a document with no checklist as one editable region', () => {
    const plain = 'Just some notes.\n\nNothing structured here.\n';
    const regions = planRegions(parsePlanDocument(plain));
    expect(regions).toHaveLength(1);
    expect(regions[0].kind).toBe('prose');
    expect(plain.slice(regions[0].range.start, regions[0].range.end)).toBe(plain);
  });

  it('has no regions for an empty document', () => {
    expect(planRegions(parsePlanDocument(''))).toEqual([]);
  });

  // Ids are what a caret hand-off and a focus restore are keyed on, so they
  // must not move when the text inside a region changes — only when the plan's
  // STRUCTURE does.
  it('keeps ids stable across an edit to a region body', () => {
    const before = planRegions(parsePlanDocument(PLAN)).map((r) => r.id);
    const edited = PLAN.replace('Apply the same conditional guard.', 'Apply it, then rebuild the grid.');
    expect(planRegions(parsePlanDocument(edited)).map((r) => r.id)).toEqual(before);
  });

  // Regions come back in SCREEN order, which is not byte order: a step card
  // shows its title and its guide together, but the title lives in `## Todos`
  // and the guide hundreds of bytes further down under `## Guide`. So step 1's
  // title sits BEFORE step 0's guide in the file and AFTER it on screen. Caret
  // hand-off follows what the user sees, so screen order is the one that ships.
  it('orders regions the way the plan is rendered, not the way the file is laid out', () => {
    const regions = planRegions(parsePlanDocument(PLAN));
    const start = (id: string) => regions.find((r) => r.id === id)!.range.start;
    expect(start('step-1-title')).toBeLessThan(start('step-0-guide'));
    expect(regions.map((r) => r.id).indexOf('step-1-title')).toBeGreaterThan(
      regions.map((r) => r.id).indexOf('step-0-guide'),
    );
  });

  it('never overlaps two regions — every byte belongs to at most one editor', () => {
    const regions = planRegions(parsePlanDocument(PLAN));
    for (const r of regions) expect(r.range.end).toBeGreaterThan(r.range.start);
    for (const a of regions) {
      for (const b of regions) {
        if (a === b) continue;
        expect(a.range.start >= b.range.end || a.range.end <= b.range.start).toBe(true);
      }
    }
  });
});

describe('regionsInOrder — caret hand-off neighbours', () => {
  it('finds the region before and after a given one', () => {
    const regions = planRegions(parsePlanDocument(PLAN));
    const { previous, next } = regionsInOrder(regions, 'step-0-guide');
    expect(previous?.id).toBe('step-0-title');
    expect(next?.id).toBe('step-1-title');
  });

  it('reports no neighbour past either end', () => {
    const regions = planRegions(parsePlanDocument(PLAN));
    expect(regionsInOrder(regions, 'prose-0').previous).toBeNull();
    expect(regionsInOrder(regions, 'prose-1').next).toBeNull();
  });

  it('reports both as null for an id that is no longer in the document', () => {
    const regions = planRegions(parsePlanDocument(PLAN));
    expect(regionsInOrder(regions, 'step-9-guide')).toEqual({ previous: null, next: null });
  });
});
