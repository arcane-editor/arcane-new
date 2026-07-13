import { describe, it, expect } from 'bun:test';
import {
  registerReviewEntry,
  clearReviewPaths,
  pendingCount,
  listPending,
  type PendingReviewEntry,
} from './review-core';

describe('registerReviewEntry', () => {
  it('registers a brand-new path with a single toolCallId and matching first/last timestamps', () => {
    const entries = registerReviewEntry(
      {},
      { path: '/Foo.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-1', now: 1000 },
    );

    expect(entries).toEqual({
      '/Foo.cs': {
        path: '/Foo.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-1'],
        firstChangeAt: 1000,
        lastChangeAt: 1000,
      },
    });
  });

  it('is immutable: does not mutate the input record', () => {
    const original: Record<string, PendingReviewEntry> = {};
    registerReviewEntry(original, {
      path: '/Foo.cs',
      turnId: 't1',
      userMessageId: 'msg-1',
      toolCallId: 'call-1',
      now: 1000,
    });

    expect(original).toEqual({});
  });

  it('dedupe: re-registering an existing path keeps the ORIGINAL turnId/userMessageId/firstChangeAt', () => {
    const first = registerReviewEntry(
      {},
      { path: '/Foo.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-1', now: 1000 },
    );
    const second = registerReviewEntry(first, {
      // A later write in a DIFFERENT (later) turn/message touches the same path —
      // the pre-image the review must revert to is still the FIRST one.
      path: '/Foo.cs',
      turnId: 't2',
      userMessageId: 'msg-2',
      toolCallId: 'call-2',
      now: 2000,
    });

    expect(second['/Foo.cs'].turnId).toBe('t1');
    expect(second['/Foo.cs'].userMessageId).toBe('msg-1');
    expect(second['/Foo.cs'].firstChangeAt).toBe(1000);
  });

  it('dedupe: appends the new toolCallId to the existing list', () => {
    const first = registerReviewEntry(
      {},
      { path: '/Foo.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-1', now: 1000 },
    );
    const second = registerReviewEntry(first, {
      path: '/Foo.cs',
      turnId: 't1',
      userMessageId: 'msg-1',
      toolCallId: 'call-2',
      now: 1500,
    });

    expect(second['/Foo.cs'].toolCallIds).toEqual(['call-1', 'call-2']);
  });

  it('dedupe: registering the SAME toolCallId again does not duplicate it', () => {
    const first = registerReviewEntry(
      {},
      { path: '/Foo.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-1', now: 1000 },
    );
    const second = registerReviewEntry(first, {
      path: '/Foo.cs',
      turnId: 't1',
      userMessageId: 'msg-1',
      toolCallId: 'call-1',
      now: 1500,
    });

    expect(second['/Foo.cs'].toolCallIds).toEqual(['call-1']);
  });

  it('dedupe: bumps lastChangeAt to the new `now`', () => {
    const first = registerReviewEntry(
      {},
      { path: '/Foo.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-1', now: 1000 },
    );
    const second = registerReviewEntry(first, {
      path: '/Foo.cs',
      turnId: 't1',
      userMessageId: 'msg-1',
      toolCallId: 'call-2',
      now: 9999,
    });

    expect(second['/Foo.cs'].lastChangeAt).toBe(9999);
  });

  it('dedupe: clears a previously-set lastRejectFailed flag', () => {
    const withFailure: Record<string, PendingReviewEntry> = {
      '/Foo.cs': {
        path: '/Foo.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-1'],
        firstChangeAt: 1000,
        lastChangeAt: 1000,
        lastRejectFailed: true,
      },
    };

    const registered = registerReviewEntry(withFailure, {
      path: '/Foo.cs',
      turnId: 't1',
      userMessageId: 'msg-1',
      toolCallId: 'call-2',
      now: 2000,
    });

    expect(registered['/Foo.cs'].lastRejectFailed).toBeFalsy();
  });

  it('does not disturb other existing entries', () => {
    const entries = registerReviewEntry(
      {
        '/Bar.cs': {
          path: '/Bar.cs',
          turnId: 't0',
          userMessageId: 'msg-0',
          toolCallIds: ['call-0'],
          firstChangeAt: 500,
          lastChangeAt: 500,
        },
      },
      { path: '/Foo.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-1', now: 1000 },
    );

    expect(Object.keys(entries).sort()).toEqual(['/Bar.cs', '/Foo.cs']);
    expect(entries['/Bar.cs'].toolCallIds).toEqual(['call-0']);
  });
});

describe('clearReviewPaths', () => {
  function fixture(): Record<string, PendingReviewEntry> {
    return {
      '/A.cs': {
        path: '/A.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-1'],
        firstChangeAt: 100,
        lastChangeAt: 100,
      },
      '/B.cs': {
        path: '/B.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-2'],
        firstChangeAt: 200,
        lastChangeAt: 200,
      },
      '/C.cs': {
        path: '/C.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-3'],
        firstChangeAt: 300,
        lastChangeAt: 300,
      },
    };
  }

  it('removes only the listed paths', () => {
    const result = clearReviewPaths(fixture(), ['/B.cs']);
    expect(Object.keys(result).sort()).toEqual(['/A.cs', '/C.cs']);
  });

  it('removes multiple listed paths', () => {
    const result = clearReviewPaths(fixture(), ['/A.cs', '/C.cs']);
    expect(Object.keys(result)).toEqual(['/B.cs']);
  });

  it('is a no-op for paths not present', () => {
    const result = clearReviewPaths(fixture(), ['/Does/Not/Exist.cs']);
    expect(Object.keys(result).sort()).toEqual(['/A.cs', '/B.cs', '/C.cs']);
  });

  it('does not mutate the input record', () => {
    const original = fixture();
    clearReviewPaths(original, ['/A.cs']);
    expect(Object.keys(original).sort()).toEqual(['/A.cs', '/B.cs', '/C.cs']);
  });

  it('handles an empty paths list (no-op)', () => {
    const original = fixture();
    const result = clearReviewPaths(original, []);
    expect(result).toEqual(original);
  });
});

describe('pendingCount', () => {
  it('returns 0 for an empty record', () => {
    expect(pendingCount({})).toBe(0);
  });

  it('returns the number of distinct paths', () => {
    const entries = registerReviewEntry(
      registerReviewEntry(
        {},
        { path: '/A.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-1', now: 1 },
      ),
      { path: '/B.cs', turnId: 't1', userMessageId: 'msg-1', toolCallId: 'call-2', now: 2 },
    );
    expect(pendingCount(entries)).toBe(2);
  });
});

describe('listPending', () => {
  it('returns [] for an empty record', () => {
    expect(listPending({})).toEqual([]);
  });

  it('orders by firstChangeAt ascending', () => {
    const entries: Record<string, PendingReviewEntry> = {
      '/Second.cs': {
        path: '/Second.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-2'],
        firstChangeAt: 2000,
        lastChangeAt: 2000,
      },
      '/First.cs': {
        path: '/First.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-1'],
        firstChangeAt: 1000,
        lastChangeAt: 1000,
      },
    };

    expect(listPending(entries).map((e) => e.path)).toEqual(['/First.cs', '/Second.cs']);
  });

  it('ties on firstChangeAt break by path (stable, deterministic ordering)', () => {
    const entries: Record<string, PendingReviewEntry> = {
      '/Zeta.cs': {
        path: '/Zeta.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-2'],
        firstChangeAt: 1000,
        lastChangeAt: 1000,
      },
      '/Alpha.cs': {
        path: '/Alpha.cs',
        turnId: 't1',
        userMessageId: 'msg-1',
        toolCallIds: ['call-1'],
        firstChangeAt: 1000,
        lastChangeAt: 1000,
      },
    };

    expect(listPending(entries).map((e) => e.path)).toEqual(['/Alpha.cs', '/Zeta.cs']);
  });
});
