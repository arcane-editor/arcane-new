import { describe, it, expect } from 'bun:test';
import { shouldRegisterReview } from './review-registration';

const BASE = { applyMode: 'auto' as const, alwaysApproveUnityAssets: true, checkpointsEnabled: true };

describe('shouldRegisterReview', () => {
  it('auto mode + normal file + checkpoints on → true', () => {
    expect(shouldRegisterReview('/proj/Foo.cs', BASE)).toBe(true);
  });

  it.each(['/proj/Assets/Scene.unity', '/proj/Assets/Player.prefab', '/proj/Assets/Grass.MAT'])(
    'auto mode + alwaysApproveUnityAssets=true + serialized Unity asset (%s, case-insensitive) → false (stays on the pre-apply prompt path)',
    (path) => {
      expect(shouldRegisterReview(path, BASE)).toBe(false);
    },
  );

  it('auto mode + alwaysApproveUnityAssets=false + a serialized Unity asset path → true', () => {
    expect(
      shouldRegisterReview('/proj/Assets/Player.prefab', { ...BASE, alwaysApproveUnityAssets: false }),
    ).toBe(true);
  });

  it('approve mode → always false, even for a normal file', () => {
    expect(shouldRegisterReview('/proj/Foo.cs', { ...BASE, applyMode: 'approve' })).toBe(false);
  });

  it('approve mode → always false, even with alwaysApproveUnityAssets=false', () => {
    expect(
      shouldRegisterReview('/proj/Foo.cs', { ...BASE, applyMode: 'approve', alwaysApproveUnityAssets: false }),
    ).toBe(false);
  });

  it('checkpointsEnabled=false → false, even in auto mode for a normal file (no pre-image, reject impossible)', () => {
    expect(shouldRegisterReview('/proj/Foo.cs', { ...BASE, checkpointsEnabled: false })).toBe(false);
  });
});
