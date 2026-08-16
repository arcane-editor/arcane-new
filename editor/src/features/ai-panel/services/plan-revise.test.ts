import { describe, it, expect } from 'bun:test';
import { buildReviseNotesPrompt } from './plan-revise';
import type { PlanNote } from '../../markdown-preview';

function note(overrides: Partial<PlanNote> = {}): PlanNote {
  return {
    id: 'n1',
    quotedText: 'do X',
    body: 'why not Y?',
    headingPath: 'Phase 1',
    anchored: true,
    ...overrides,
  };
}

describe('buildReviseNotesPrompt', () => {
  it('embeds the full current plan and its path', () => {
    const p = buildReviseNotesPrompt('/ws/.arcane/plans/p.md', '# Plan\n- [ ] step', [note()]);
    expect(p).toContain('# Plan\n- [ ] step');
    expect(p).toContain('/ws/.arcane/plans/p.md');
  });

  it('asks for the FULL plan as the reply — never an instruction to write files', () => {
    // plan-planning's toolset is read-only by design: an instruction to
    // "write the plan back to the file" can only ever be silently ignored.
    const p = buildReviseNotesPrompt('/p.md', 'plan', [note()]);
    expect(p).toContain('Reply with the FULL revised plan');
    expect(p.toLowerCase()).not.toContain('write the full revised plan back');
  });

  it('numbers each note under its heading with the quoted text', () => {
    const p = buildReviseNotesPrompt('/p.md', 'plan', [
      note(),
      note({ id: 'n2', quotedText: 'do Z', body: 'too vague', headingPath: 'Phase 2' }),
    ]);
    expect(p).toContain('1. under "Phase 1"\n   > do X\n   why not Y?');
    expect(p).toContain('2. under "Phase 2"\n   > do Z\n   too vague');
  });

  it('marks unanchored notes as general feedback', () => {
    const p = buildReviseNotesPrompt('/p.md', 'plan', [note({ anchored: false })]);
    expect(p).toContain('no longer in the plan');
  });
});
