import { describe, it, expect } from 'bun:test';
import { useCheckpointsStore } from './checkpoints';
import type { CheckpointTurn } from '../features/ai-panel';

// `reanchorTurns` (like `beginTurn`/`recordPreWrite`) schedules a DEBOUNCED
// persist (`schedulePersist`, 600ms) whose actual barrel touch — a dynamic
// `import('../features/ai-panel')` inside `persistNow()` — only fires once
// the timer elapses. Every test below stays well under that window and ends
// by calling `reset()`, which cancels the pending timer (see
// `checkpoints.ts`'s `reset` action) before it ever gets a chance to run —
// so the barrel is never actually touched here.
//
// Deliberately NOT using `mock.module('../features/ai-panel', ...)` the way
// `stores/edit-review.test.ts` does for its own (immediate, `flushNow`-driven)
// persistence test: `mock.module` registrations are process-global in Bun, and
// `edit-review.test.ts`'s header explicitly documents "no other test file
// imports the ai-panel barrel" as the invariant that makes its mock safe. A
// second, differently-shaped mock for the same specifier in this file would
// silently clobber that one (whichever test file's mock registers last wins
// for the rest of the `bun test` process), breaking edit-review.test.ts's
// `registerForActiveTurn`/`saveReviews` expectations. Testing only the pure
// state transition (never letting the debounce fire) sidesteps the conflict
// entirely.
function turn(turnId: string, userMessageId: string): CheckpointTurn {
  return {
    turnId,
    sessionId: 'sess-1',
    userMessageId,
    timestamp: 0,
    entries: [{ path: '/Foo.cs', kind: 'modified', beforeContent: 'old', timestamp: 0 }],
  };
}

// T10 fix wave: Retry truncates the failed turn's user bubble out of the
// store and replays under a BRAND NEW bubble id — without reanchoring, the
// failed turn's own checkpoint entries (recorded under the old, now-deleted
// id) become permanently unreachable, since `CheckpointRow` only ever
// renders a turn for a LIVE message id. See `stores/checkpoints.ts`'s
// `reanchorTurns` header and `retry-turn.ts`'s `reanchorRetryCheckpoints`.
describe('useCheckpointsStore.reanchorTurns', () => {
  it('reassigns the matching turn to the new userMessageId, leaving others untouched', () => {
    useCheckpointsStore.getState().reset();
    useCheckpointsStore.setState({
      sessionId: 'sess-1',
      turns: [turn('t1', 'msg-old'), turn('t2', 'msg-other')],
    });

    useCheckpointsStore.getState().reanchorTurns('msg-old', 'msg-new');

    const { turns } = useCheckpointsStore.getState();
    expect(turns.find((t) => t.turnId === 't1')?.userMessageId).toBe('msg-new');
    expect(turns.find((t) => t.turnId === 't2')?.userMessageId).toBe('msg-other');
    useCheckpointsStore.getState().reset();
  });

  it('reanchors every turn sharing the old id (plan-execution can stack more than one turn per message)', () => {
    useCheckpointsStore.getState().reset();
    useCheckpointsStore.setState({
      sessionId: 'sess-1',
      turns: [turn('t1', 'msg-old'), turn('t2', 'msg-old'), turn('t3', 'msg-other')],
    });

    useCheckpointsStore.getState().reanchorTurns('msg-old', 'msg-new');

    const { turns } = useCheckpointsStore.getState();
    expect(turns.filter((t) => t.userMessageId === 'msg-new').map((t) => t.turnId)).toEqual(['t1', 't2']);
    expect(turns.find((t) => t.turnId === 't3')?.userMessageId).toBe('msg-other');
    useCheckpointsStore.getState().reset();
  });

  it('is a no-op when nothing matches oldUserMessageId', () => {
    useCheckpointsStore.getState().reset();
    const original = [turn('t1', 'msg-a')];
    useCheckpointsStore.setState({ sessionId: 'sess-1', turns: original });

    useCheckpointsStore.getState().reanchorTurns('msg-nonexistent', 'msg-new');

    expect(useCheckpointsStore.getState().turns).toEqual(original);
    useCheckpointsStore.getState().reset();
  });

  it('preserves every other field on the reanchored turn (only userMessageId changes)', () => {
    useCheckpointsStore.getState().reset();
    const original = turn('t1', 'msg-old');
    useCheckpointsStore.setState({ sessionId: 'sess-1', turns: [original] });

    useCheckpointsStore.getState().reanchorTurns('msg-old', 'msg-new');

    const [reanchored] = useCheckpointsStore.getState().turns;
    expect(reanchored).toEqual({ ...original, userMessageId: 'msg-new' });
    useCheckpointsStore.getState().reset();
  });
});
