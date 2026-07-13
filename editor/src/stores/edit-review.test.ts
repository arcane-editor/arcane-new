import { describe, it, expect } from 'bun:test';
import { useEditReviewStore } from './edit-review';
import { useCheckpointsStore } from './checkpoints';

// This store's actions reach `features/ai-panel`'s barrel through a dynamic
// `import()` the moment they're actually invoked (Bun-safety — see
// `edit-review.ts`'s header), so only the branches that return BEFORE ever
// reaching that import are safe to exercise directly here (the same
// limitation `stores/checkpoints.ts` has, with no direct test file of its
// own). The nontrivial branching everything else relies on is tested in
// `features/ai-panel/services/edit-review/review-core.test.ts`
// (`registerForActiveTurn`, `markRejectFailed`) and
// `edit-review-decorator.test.ts` (`register`'s call site, via a DI seam).

describe('useEditReviewStore', () => {
  it('starts with no pending entries and no session', () => {
    useEditReviewStore.getState().reset();
    expect(useEditReviewStore.getState().entries).toEqual({});
    expect(useEditReviewStore.getState().sessionId).toBeNull();
  });

  it('register no-ops when there is no active checkpoint turn (no pre-image to reject back to)', () => {
    useEditReviewStore.getState().reset();
    useCheckpointsStore.getState().reset();
    expect(useCheckpointsStore.getState().turns).toEqual([]);

    useEditReviewStore.getState().register('/Foo.cs', 'call-1');

    expect(useEditReviewStore.getState().entries).toEqual({});
  });

  it('clearForPaths([]) is a no-op', () => {
    useEditReviewStore.getState().reset();
    useEditReviewStore.setState({
      entries: {
        '/Foo.cs': {
          path: '/Foo.cs',
          turnId: 't1',
          userMessageId: 'msg-1',
          toolCallIds: ['call-1'],
          firstChangeAt: 1000,
          lastChangeAt: 1000,
        },
      },
    });

    useEditReviewStore.getState().clearForPaths([]);

    expect(Object.keys(useEditReviewStore.getState().entries)).toEqual(['/Foo.cs']);
  });

  it('reset() clears entries and sessionId', () => {
    useEditReviewStore.setState({
      sessionId: 'sess-1',
      entries: {
        '/Foo.cs': {
          path: '/Foo.cs',
          turnId: 't1',
          userMessageId: 'msg-1',
          toolCallIds: ['call-1'],
          firstChangeAt: 1000,
          lastChangeAt: 1000,
        },
      },
    });

    useEditReviewStore.getState().reset();

    expect(useEditReviewStore.getState().entries).toEqual({});
    expect(useEditReviewStore.getState().sessionId).toBeNull();
  });
});
