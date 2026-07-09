import { describe, it, expect } from 'bun:test';
import { decideRevertOutcome } from './revert-outcome';
import type { RestoreResult } from '../../../../stores/checkpoints';

function result(overrides: Partial<RestoreResult> = {}): RestoreResult {
  return { restored: [], skippedTooLarge: [], failed: [], ...overrides };
}

describe('decideRevertOutcome (Finding 2 regression)', () => {
  it('reports "reverted" when the path is in `restored`', () => {
    expect(decideRevertOutcome(result({ restored: ['/proj/Foo.cs'] }), '/proj/Foo.cs')).toBe(
      'reverted',
    );
  });

  it('reports "failed" when the path is in `failed` — does NOT report success', () => {
    expect(decideRevertOutcome(result({ failed: ['/proj/Foo.cs'] }), '/proj/Foo.cs')).toBe('failed');
  });

  it('reports "failed" when the path is in `skippedTooLarge` — does NOT report success', () => {
    expect(decideRevertOutcome(result({ skippedTooLarge: ['/proj/Foo.cs'] }), '/proj/Foo.cs')).toBe(
      'failed',
    );
  });

  it('reports "failed" defensively when the path appears in none of the arrays', () => {
    expect(decideRevertOutcome(result({ restored: ['/proj/Other.cs'] }), '/proj/Foo.cs')).toBe(
      'failed',
    );
  });

  it('only decides for the requested path — an unrelated failure does not poison a successful one', () => {
    expect(
      decideRevertOutcome(
        result({ restored: ['/proj/Foo.cs'], failed: ['/proj/Bar.cs'] }),
        '/proj/Foo.cs',
      ),
    ).toBe('reverted');
  });
});
