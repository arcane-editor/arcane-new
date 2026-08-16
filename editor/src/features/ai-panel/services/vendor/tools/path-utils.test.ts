import { describe, it, expect } from 'bun:test';
import {
  resolveWithinRoot,
  primaryRoot,
  pathOutsideRootMessage,
  PathOutsideRootError,
} from './path-utils';

// The sandbox must accept a LIST of roots. In Unity projects it used to be
// Assets/ alone, which blocked the agent from its own plan files under
// <workspace>/.arcane/ — resume sends could not re-read the plan ("this
// environment blocks access to .arcane/") and checkbox ticking silently never
// worked (every plan stuck at 0/N done).
describe('resolveWithinRoot with multiple roots', () => {
  const ROOTS = ['/proj/Assets', '/proj/.arcane'] as const;

  it('accepts a path inside the first root', () => {
    expect(resolveWithinRoot('Assets/Scripts/Foo.cs', '/proj', ROOTS)).toBe('/proj/Assets/Scripts/Foo.cs');
  });

  it('accepts a path inside a later root (the plan file case)', () => {
    expect(resolveWithinRoot('/proj/.arcane/plans/p.md', '/proj', ROOTS)).toBe('/proj/.arcane/plans/p.md');
  });

  it('rejects a path outside every root', () => {
    expect(() => resolveWithinRoot('/proj/ProjectSettings/Tags.asset', '/proj', ROOTS)).toThrow(
      PathOutsideRootError,
    );
  });

  it('keeps single-string and null behavior unchanged', () => {
    expect(resolveWithinRoot('Assets/A.cs', '/proj', '/proj/Assets')).toBe('/proj/Assets/A.cs');
    expect(() => resolveWithinRoot('/etc/passwd', '/proj', '/proj/Assets')).toThrow(PathOutsideRootError);
    expect(resolveWithinRoot('/anywhere/at/all.txt', '/proj', null)).toBe('/anywhere/at/all.txt');
  });

  it('containment is case-insensitive for every root', () => {
    expect(resolveWithinRoot('/proj/assets/A.cs', '/proj', ROOTS)).toBe('/proj/assets/A.cs');
    expect(resolveWithinRoot('/proj/.ARCANE/plans/p.md', '/proj', ROOTS)).toBe('/proj/.ARCANE/plans/p.md');
  });

  it('the error names every allowed root so the model can self-correct', () => {
    try {
      resolveWithinRoot('/elsewhere/x.cs', '/proj', ROOTS);
      throw new Error('expected PathOutsideRootError');
    } catch (e) {
      const msg = pathOutsideRootMessage(e as PathOutsideRootError);
      expect(msg).toContain('/proj/Assets');
      expect(msg).toContain('/proj/.arcane');
    }
  });
});

describe('primaryRoot', () => {
  it('returns the first root of a list, the string itself, or null', () => {
    expect(primaryRoot(['/proj/Assets', '/proj/.arcane'])).toBe('/proj/Assets');
    expect(primaryRoot('/proj/Assets')).toBe('/proj/Assets');
    expect(primaryRoot(null)).toBeNull();
    expect(primaryRoot([])).toBeNull();
  });
});
