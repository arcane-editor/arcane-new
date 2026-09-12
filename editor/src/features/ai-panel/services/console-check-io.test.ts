// `console-check-io.ts` is the store/RPC half of the post-turn console check:
// it statically imports `stores/unity` and `unity-bridge`'s `bridgeRpc`, both
// of which reach `document` transitively, so it cannot be imported under Bun
// (Global Constraint 4). Its one non-obvious decision — how a snapshot row's
// wire `seq` is mapped — is pinned here by source text (Global Constraint 14),
// with the consequence exercised for real through `collectNewProblems`.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { collectNewProblems, type CollectInput, type ConsoleEntryInput } from './console-check';

const IO_SRC = readFileSync(path.resolve(import.meta.dir, './console-check-io.ts'), 'utf8');
const STORE_SRC = readFileSync(
  path.resolve(import.meta.dir, '../../../stores/unity.ts'),
  'utf8',
);

describe('console-check-io.ts — a snapshot row\'s Unity row index (I3)', () => {
  // `getConsoleSnapshot` answers from Unity's real console
  // (`source: 'logEntries'`) when it can, and from the bridge's own reflection
  // fallback ring (`source: 'hookRing'`) when Unity's console API is
  // unavailable on that Editor version. Only the first answer's `seq` is a
  // CONSOLE ROW INDEX; the second's is `ConsoleHook.Seq`, a per-session ring
  // counter. Feeding that counter to the adoption rule (which compares it
  // against the row index high-water mark taken at send start) adopted
  // hours-old errors as "new this turn" — most visibly right after a console
  // clear, when the ring counter keeps climbing past a stale mark.
  it('only takes the wire seq as a row index for a logEntries answer', () => {
    expect(IO_SRC).toContain("unityRow: snap.source === 'logEntries' ? row.seq : null,");
    expect(IO_SRC).not.toContain('unityRow: row.seq,');
  });

  it('applies the same rule the store applies to a backfilled row', () => {
    // `backfillConsoleHistory` has always dropped a hookRing seq; this is the
    // read path finally agreeing with it, so the two can never disagree about
    // what `unityRow` means.
    expect(STORE_SRC).toContain("unityRow: snapshot.source === 'logEntries' ? e.seq : undefined,");
  });
});

describe('the consequence: a hookRing row is never adopted as new this turn', () => {
  function input(overrides: Partial<CollectInput> = {}): CollectInput {
    return {
      baseline: {
        seq: 10,
        epoch: 1,
        startedAt: 1_000,
        compileIdentity: null,
        editorAwake: true,
        // Unity's console had reached row 100 when the send started.
        maxUnityRow: 100,
      },
      ring: [],
      snapshot: null,
      snapshotStatus: 'not-attempted',
      connected: true,
      bridgeProtocol: 4,
      editorAwake: true,
      compileErrors: [],
      testRun: null,
      ...overrides,
    };
  }

  const stale: ConsoleEntryInput = {
    logType: 'Exception',
    message: 'NullReferenceException: from an hour ago',
    seq: null,
    stackTrace: 'Player.Update () (at Assets/Scripts/Player.cs:42)',
  };

  it('adopts nothing when the row carries no index — how a hookRing row now arrives', () => {
    const out = collectNewProblems(
      input({ snapshot: [{ ...stale, unityRow: null }], snapshotStatus: 'used' }),
    );

    expect(out.console).toHaveLength(0);
    expect(out.snapshotAdoption).toBe('none-matched');
  });

  it('WOULD have adopted it had the ring counter been passed through as a row index', () => {
    // The bug, spelled out: `ConsoleHook.Seq` climbs with every logged line, so
    // it sails past a send-start high-water mark that means something else
    // entirely — and the stale error is presented to the repair pass as this
    // turn's damage.
    const out = collectNewProblems(
      input({ snapshot: [{ ...stale, unityRow: 4_211 }], snapshotStatus: 'used' }),
    );

    expect(out.console).toHaveLength(1);
    expect(out.snapshotAdoption).toBe('adopted');
  });
});
