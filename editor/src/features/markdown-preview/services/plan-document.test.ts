import { describe, it, expect } from 'bun:test';
import { parsePlanDocument, type PlanBlock } from './plan-document';
import { toggleTaskAt } from './block-edit';

/** The exact shape `prompts/plan-planning.ts` asks the model to produce. */
const PLAN = `# Fix API 404s

## Goal
Return 404 only when a domain is genuinely missing.

## Context
Two endpoints share the same catch block.

## Todos
- [x] T1 [easy] Fix GET /homePage/domain/:domainName
- [ ] T2 [hard] Fix GET /b2b/domain/:domainName

## Guide

### T1: Fix GET /homePage/domain/:domainName
File: api/rest-endpoints/landingpage.ts

### T2: Fix GET /b2b/domain/:domainName
Apply the same conditional guard.

## Risks
- Alerts could go quiet.

STOP — review and edit before execution.
`;

function textOf(doc: string, block: PlanBlock): string {
  if (block.kind !== 'markdown') throw new Error('not a markdown block');
  return doc.slice(block.range.start, block.range.end);
}

describe('parsePlanDocument', () => {
  it('pairs each todo with its guide entry', () => {
    const parsed = parsePlanDocument(PLAN);
    expect(parsed.structured).toBe(true);
    expect(parsed.steps).toHaveLength(2);

    const [t1, t2] = parsed.steps;
    expect(PLAN.slice(t1.guide!.start, t1.guide!.end).trim())
      .toBe('File: api/rest-endpoints/landingpage.ts');
    expect(PLAN.slice(t2.guide!.start, t2.guide!.end).trim())
      .toBe('Apply the same conditional guard.');
  });

  // The whole point of the redesign: the ids and difficulty tags stay in the
  // file for the executor and never reach the reader.
  it('strips the T<n> id and the [easy]/[hard] tag from the displayed title', () => {
    const [t1, t2] = parsePlanDocument(PLAN).steps;
    expect(t1.title).toBe('Fix GET /homePage/domain/:domainName');
    expect(t2.title).toBe('Fix GET /b2b/domain/:domainName');
    expect(`${t1.title}${t2.title}`).not.toContain('[easy]');
    expect(`${t1.title}${t2.title}`).not.toContain('[hard]');
    expect(`${t1.title}${t2.title}`).not.toMatch(/\bT\d/);
  });

  // Editing a title must splice ONLY the title. If titleRange covered the
  // prefix, renaming a step would drop the tag the executor routes on — the
  // one failure a user could never see coming, since the tag isn't rendered.
  it('points titleRange at the title alone, leaving the id and tag intact', () => {
    const [t1] = parsePlanDocument(PLAN).steps;
    expect(PLAN.slice(t1.titleRange.start, t1.titleRange.end))
      .toBe('Fix GET /homePage/domain/:domainName');

    const renamed =
      PLAN.slice(0, t1.titleRange.start) + 'Renamed' + PLAN.slice(t1.titleRange.end);
    expect(renamed).toContain('- [x] T1 [easy] Renamed');
  });

  it('reports done state and an order-derived ordinal', () => {
    const steps = parsePlanDocument(PLAN).steps;
    expect(steps.map((s) => s.done)).toEqual([true, false]);
    expect(steps.map((s) => s.ordinal)).toEqual([1, 2]);
  });

  it('numbers by position, not by the model’s T<n> ids', () => {
    const gappy = '## Todos\n- [ ] T2 [easy] Second\n- [ ] T7 [hard] Seventh\n';
    expect(parsePlanDocument(gappy).steps.map((s) => s.ordinal)).toEqual([1, 2]);
  });

  it('gives the checkbox offset back on the checkbox line', () => {
    const [t1] = parsePlanDocument(PLAN).steps;
    const line = PLAN.slice(t1.checkboxOffset, PLAN.indexOf('\n', t1.checkboxOffset));
    expect(line).toBe('- [x] T1 [easy] Fix GET /homePage/domain/:domainName');
  });

  it('splits the document into lead, steps and tail in order', () => {
    const { blocks } = parsePlanDocument(PLAN);
    expect(blocks.map((b) => b.kind)).toEqual(['markdown', 'steps', 'markdown']);
    expect(textOf(PLAN, blocks[0])).toContain('# Fix API 404s');
    expect(textOf(PLAN, blocks[0])).toContain('## Context');
    // The `## Todos` heading goes with the steps — the cards are the list.
    expect(textOf(PLAN, blocks[0])).not.toContain('## Todos');
    expect(textOf(PLAN, blocks[2])).toContain('## Risks');
  });

  it('drops the model’s trailing STOP instruction from the tail', () => {
    const { blocks } = parsePlanDocument(PLAN);
    expect(textOf(PLAN, blocks[2])).not.toContain('STOP');
  });

  it('keeps a guide entry that matches no todo rather than hiding it', () => {
    const extra = PLAN.replace(
      '## Risks',
      '### T9: Orphaned guidance\nThis matched no todo.\n\n## Risks',
    );
    const { blocks } = parsePlanDocument(extra);
    const all = blocks.map((b) => (b.kind === 'markdown' ? textOf(extra, b) : '')).join('\n');
    expect(all).toContain('This matched no todo.');
  });

  it('falls back to positional pairing when the guide headings carry no ids', () => {
    const noIds = PLAN.replace('### T1: ', '### ').replace('### T2: ', '### ');
    const [t1, t2] = parsePlanDocument(noIds).steps;
    expect(noIds.slice(t1.guide!.start, t1.guide!.end)).toContain('landingpage.ts');
    expect(noIds.slice(t2.guide!.start, t2.guide!.end)).toContain('conditional guard');
  });

  it('leaves steps without a guide when there is no Guide section', () => {
    const bare = '# T\n\n## Todos\n- [ ] T1 [easy] Only a todo\n';
    const parsed = parsePlanDocument(bare);
    expect(parsed.steps[0].guide).toBeNull();
    expect(parsed.steps[0].title).toBe('Only a todo');
  });

  it('handles a plan with no ids or tags at all', () => {
    const plain = '## Todos\n- [ ] Just a title\n- [x] Another\n';
    const steps = parsePlanDocument(plain).steps;
    expect(steps.map((s) => s.title)).toEqual(['Just a title', 'Another']);
    expect(steps.map((s) => s.done)).toEqual([false, true]);
  });

  // Resilience contract: a hand-edited file must still show all of its text.
  it('degrades to one markdown block when there is no checklist', () => {
    const prose = '# Notes\n\nJust prose, no todos.\n';
    const parsed = parsePlanDocument(prose);
    expect(parsed.structured).toBe(false);
    expect(parsed.steps).toEqual([]);
    expect(textOf(prose, parsed.blocks[0])).toBe(prose);
  });

  it('returns empty, never throws, for degenerate input', () => {
    for (const bad of ['', null, undefined, 42, {}, []] as unknown[]) {
      const parsed = parsePlanDocument(bad as string);
      expect(parsed.structured).toBe(false);
      expect(parsed.steps).toEqual([]);
    }
  });

  // The view renders each block as its own MarkdownPreview over a SLICE of the
  // file, and that preview reports edit offsets as `base + localOffset`. If a
  // base is off by one, an edit silently splices the wrong characters into the
  // user's plan — so pin the round trip, not just the ranges.
  describe('slice offsets round-trip through an edit', () => {
    it('rewrites a guide body from offsets reported against the slice', () => {
      const [t1] = parsePlanDocument(PLAN).steps;
      const base = t1.guide!.start;
      const slice = PLAN.slice(base, t1.guide!.end);

      // What MarkdownPreview would report for the paragraph inside the slice.
      const localStart = slice.indexOf('File:');
      const localEnd = slice.indexOf('\n', localStart);
      const next =
        PLAN.slice(0, base + localStart) + 'Rewritten.' + PLAN.slice(base + localEnd);

      expect(next).toContain('### T1: Fix GET /homePage/domain/:domainName\nRewritten.');
      expect(next).toContain('Apply the same conditional guard.');
      expect(next).toContain('- [x] T1 [easy] Fix GET /homePage/domain/:domainName');
    });

    it('keeps every block\u2019s slice matching the text it renders', () => {
      const { blocks } = parsePlanDocument(PLAN);
      for (const block of blocks) {
        if (block.kind !== 'markdown') continue;
        const { start, end } = block.range;
        expect(PLAN.slice(start, end)).toBe(PLAN.substring(start, end));
        expect(start).toBeGreaterThanOrEqual(0);
        expect(end).toBeLessThanOrEqual(PLAN.length);
      }
    });

    it('gives each step a checkbox offset that toggles only that step', () => {
      const steps = parsePlanDocument(PLAN).steps;
      const toggled = toggleTaskAt(PLAN, steps[1].checkboxOffset)!;
      expect(toggled).toContain('- [x] T2 [hard] Fix GET /b2b/domain/:domainName');
      // The first step is untouched.
      expect(toggled).toContain('- [x] T1 [easy] Fix GET /homePage/domain/:domainName');
      expect(parsePlanDocument(toggled).steps.map((s) => s.done)).toEqual([true, true]);
    });
  });

  it('never loses non-blank text from a well-formed plan', () => {
    const { blocks } = parsePlanDocument(PLAN);
    const shown = blocks
      .map((b) =>
        b.kind === 'markdown'
          ? textOf(PLAN, b)
          : b.steps.map((s) => `${s.title}${s.guide ? PLAN.slice(s.guide.start, s.guide.end) : ''}`).join('\n'),
      )
      .join('\n');
    // Everything except the structural bookkeeping the UI now expresses itself.
    for (const phrase of [
      'Return 404 only when a domain is genuinely missing.',
      'Two endpoints share the same catch block.',
      'Fix GET /homePage/domain/:domainName',
      'File: api/rest-endpoints/landingpage.ts',
      'Apply the same conditional guard.',
      'Alerts could go quiet.',
    ]) {
      expect(shown).toContain(phrase);
    }
  });
});
