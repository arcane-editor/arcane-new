import { describe, it, expect } from 'bun:test';
import { assertWithinRootReal, type RealPathOps } from './real-path-guard';
import { PathOutsideRootError } from './path-utils';

/** A fake filesystem: `links` maps a real-or-linked path to what it resolves to. */
function fs(paths: string[], links: Record<string, string> = {}): RealPathOps {
  const set = new Set(paths);
  return {
    exists: async (p) => set.has(p),
    canonicalize: async (p) => links[p] ?? p,
  };
}

const ROOT = '/proj/Assets';

describe('assertWithinRootReal', () => {
  it('allows an ordinary path inside the root', async () => {
    const ops = fs(['/proj/Assets', '/proj/Assets/Scripts/A.cs']);
    await expect(assertWithinRootReal('/proj/Assets/Scripts/A.cs', ROOT, ops)).resolves.toBeUndefined();
  });

  // The escape. `resolveWithinRoot` compares strings, so this path IS inside the
  // root lexically — and then `write_file` follows the link straight out of the
  // project. Symlinked asset folders are a normal Unity workflow.
  it('refuses a path that only looks contained because of a symlink', async () => {
    const ops = fs(['/proj/Assets', '/proj/Assets/Shared'], {
      '/proj/Assets/Shared': '/elsewhere/shared',
    });
    await expect(
      assertWithinRootReal('/proj/Assets/Shared/Secret.cs', ROOT, ops),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  it('refuses a symlinked file itself, not just a directory', async () => {
    const ops = fs(['/proj/Assets', '/proj/Assets/link.cs'], {
      '/proj/Assets/link.cs': '/etc/passwd',
    });
    await expect(assertWithinRootReal('/proj/Assets/link.cs', ROOT, ops)).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
  });

  // `write` legitimately creates files that do not exist yet. Canonicalizing a
  // missing path returns it unchanged, so containment has to be decided by its
  // nearest existing ancestor or a new file inside a symlinked dir slips through.
  it('allows creating a NEW file inside the root', async () => {
    const ops = fs(['/proj/Assets', '/proj/Assets/Scripts']);
    await expect(
      assertWithinRootReal('/proj/Assets/Scripts/Brand/New.cs', ROOT, ops),
    ).resolves.toBeUndefined();
  });

  it('refuses a NEW file inside a symlinked directory', async () => {
    const ops = fs(['/proj/Assets', '/proj/Assets/Shared'], {
      '/proj/Assets/Shared': '/elsewhere/shared',
    });
    await expect(
      assertWithinRootReal('/proj/Assets/Shared/New.cs', ROOT, ops),
    ).rejects.toBeInstanceOf(PathOutsideRootError);
  });

  // The false positive that would break the app outright: on macOS `/tmp` really
  // is `/private/tmp`, so a workspace under any symlinked parent must still work.
  it('canonicalizes the ROOT too, so a symlinked workspace still works', async () => {
    const ops = fs(['/tmp/proj/Assets', '/tmp/proj/Assets/A.cs'], {
      '/tmp/proj/Assets': '/private/tmp/proj/Assets',
      '/tmp/proj/Assets/A.cs': '/private/tmp/proj/Assets/A.cs',
    });
    await expect(
      assertWithinRootReal('/tmp/proj/Assets/A.cs', '/tmp/proj/Assets', ops),
    ).resolves.toBeUndefined();
  });

  it('accepts a path under any of several roots', async () => {
    const ops = fs(['/proj/Assets', '/proj/.arcane', '/proj/.arcane/plans/p.aplan']);
    await expect(
      assertWithinRootReal('/proj/.arcane/plans/p.aplan', ['/proj/Assets', '/proj/.arcane'], ops),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when no sandbox is configured', async () => {
    const ops = fs([]);
    await expect(assertWithinRootReal('/anywhere/at/all', null, ops)).resolves.toBeUndefined();
  });

  it('denies everything when the root list is empty (no workspace open)', async () => {
    const ops = fs([]);
    await expect(assertWithinRootReal('/proj/Assets/A.cs', [], ops)).rejects.toBeInstanceOf(
      PathOutsideRootError,
    );
  });
});
