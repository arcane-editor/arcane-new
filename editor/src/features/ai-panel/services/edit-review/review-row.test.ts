import { describe, expect, test } from 'bun:test';
import { formatReviewRowLabel } from './review-row';

describe('formatReviewRowLabel', () => {
  test('relativizes an absolute path under the workspace root', () => {
    expect(formatReviewRowLabel('/proj/Assets/Scripts/Player.cs', '/proj')).toEqual({
      name: 'Player.cs',
      dirHint: 'Assets/Scripts',
    });
  });

  test('case-tolerant root match (macOS/Windows default case-insensitive filesystems)', () => {
    expect(formatReviewRowLabel('/Users/dev/Proj/Assets/Foo.cs', '/users/dev/proj')).toEqual({
      name: 'Foo.cs',
      dirHint: 'Assets',
    });
  });

  test('file directly at the workspace root has no dir hint', () => {
    expect(formatReviewRowLabel('/proj/README.md', '/proj')).toEqual({
      name: 'README.md',
      dirHint: '',
    });
  });

  test('falls back to the raw path when workspacePath is unknown', () => {
    expect(formatReviewRowLabel('/proj/Assets/Foo.cs', null)).toEqual({
      name: 'Foo.cs',
      dirHint: '/proj/Assets',
    });
  });

  test('absolute path outside the workspace root falls back to the raw path', () => {
    expect(formatReviewRowLabel('/other/Foo.cs', '/proj')).toEqual({
      name: 'Foo.cs',
      dirHint: '/other',
    });
  });
});
