import { describe, it, expect } from 'bun:test';
import { scoreMentionMatch } from './mention-search';

// The real path from the 2026-08-24 report. Typing `@SOP/index.tsx` matched
// nothing, and this is why: the path tier scored `25 - relPath.length`, then
// the caller kept only `score >= 0`. This path is 85 characters, so it scored
// -60 and was dropped. Path search could only ever find files sitting within
// 25 characters of the workspace root — in practice, nothing.
const REAL_REL = 'student-ui/src/components/IITApplicationsV2/QualifierTestStep/Counselling/SOP/index.tsx';
const REAL_BASE = 'index.tsx';

describe('scoreMentionMatch — path queries', () => {
  it('finds a deeply nested file by a path fragment', () => {
    expect(scoreMentionMatch('SOP/index.tsx', REAL_BASE, REAL_REL)).not.toBeNull();
  });

  it('does not punish a long path into oblivion', () => {
    const score = scoreMentionMatch('SOP/index.tsx', REAL_BASE, REAL_REL);
    expect(score).toBeGreaterThan(0);
  });

  it('matches a partial path fragment too', () => {
    expect(scoreMentionMatch('Counselling/SOP', REAL_BASE, REAL_REL)).not.toBeNull();
  });

  it('is case-insensitive on both sides', () => {
    expect(scoreMentionMatch('sop/INDEX.tsx', REAL_BASE, REAL_REL)).not.toBeNull();
  });

  it('accepts a backslash path, so a Windows-style paste still matches', () => {
    expect(scoreMentionMatch('SOP\\index.tsx', REAL_BASE, REAL_REL)).not.toBeNull();
  });

  it('still rejects a genuine non-match', () => {
    expect(scoreMentionMatch('does/not/exist.ts', REAL_BASE, REAL_REL)).toBeNull();
  });

  it('returns null for an empty query rather than matching everything', () => {
    expect(scoreMentionMatch('', REAL_BASE, REAL_REL)).toBeNull();
  });
});

describe('scoreMentionMatch — ranking', () => {
  it('ranks a basename prefix above a basename substring', () => {
    const prefix = scoreMentionMatch('index', 'index.tsx', 'a/index.tsx')!;
    const substr = scoreMentionMatch('index', 'myindex.tsx', 'a/myindex.tsx')!;
    expect(prefix).toBeGreaterThan(substr);
  });

  it('ranks a basename match above a path-only match', () => {
    const name = scoreMentionMatch('sop', 'sop.tsx', 'a/sop.tsx')!;
    const path = scoreMentionMatch('sop', 'index.tsx', 'a/SOP/index.tsx')!;
    expect(name).toBeGreaterThan(path);
  });

  // The tie-break that the old formula tried to express, kept — but it must
  // only order WITHIN a tier, never demote a match out of its tier.
  it('prefers the shorter of two equally-tiered matches', () => {
    const shortPath = scoreMentionMatch('sop', 'index.tsx', 'SOP/index.tsx')!;
    const longPath = scoreMentionMatch('sop', 'index.tsx', REAL_REL)!;
    expect(shortPath).toBeGreaterThan(longPath);
  });

  it('keeps a very long path ranked above no match at all', () => {
    const deep = 'a/'.repeat(300) + 'SOP/index.tsx';
    expect(scoreMentionMatch('sop/index.tsx', 'index.tsx', deep)).toBeGreaterThan(0);
  });
});
