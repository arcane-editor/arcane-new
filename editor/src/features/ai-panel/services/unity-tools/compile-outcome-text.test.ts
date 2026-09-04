// Byte-pins `describeCompileOutcome` against the exact strings
// `compile-gate.ts` shipped before this extraction — see that file's own
// `compile-gate.test.ts`, which asserts the WRAPPED (`[Unity compile] ...`)
// text and must stay green unmodified. These tests assert the un-wrapped
// fragment this function actually owns.

import { describe, it, expect } from 'bun:test';
import { describeCompileOutcome } from './compile-outcome-text';
import type { CompileWaitOutcome } from '../../../unity-bridge';
import type { CompilerMessage } from '../../../../types/unity';

function errorReport(messages: CompilerMessage[]): CompileWaitOutcome {
  return {
    status: 'report',
    report: {
      started: false,
      success: messages.every((m) => m.type !== 'Error'),
      errors: messages.filter((m) => m.type === 'Error').length,
      warnings: 0,
      messages,
    },
  };
}

describe('describeCompileOutcome', () => {
  it('no-compile', () => {
    expect(describeCompileOutcome({ status: 'no-compile' })).toBe(
      'Assets refreshed — no recompile was needed.',
    );
  });

  it('report with zero errors — the clean note', () => {
    expect(describeCompileOutcome(errorReport([]))).toBe('Clean — no compiler errors.');
  });

  it('report with errors — returns empty; the caller formats the error list', () => {
    expect(
      describeCompileOutcome(
        errorReport([{ file: 'Assets/Foo.cs', line: 1, column: 1, message: 'boom', type: 'Error' }]),
      ),
    ).toBe('');
  });

  it('unknown/aborted — returns empty; the gate says nothing on top of the write result', () => {
    expect(describeCompileOutcome({ status: 'unknown', reason: 'aborted' })).toBe('');
  });

  it('unknown/timeout', () => {
    const text = describeCompileOutcome({ status: 'unknown', reason: 'timeout' });
    expect(text).toBe(
      "Compile status unknown (timed out waiting for Unity's report). " +
        'This is NOT a failure: the write succeeded — continue with the remaining file work, ' +
        'and verify before finishing the task.',
    );
  });

  it('unknown/bridge-lost', () => {
    const text = describeCompileOutcome({ status: 'unknown', reason: 'bridge-lost' });
    expect(text).toBe(
      'Compile status unknown (Unity bridge was lost mid-compile; it reconnects automatically ' +
        'after the reload). This is NOT a failure: the write succeeded — continue with the ' +
        'remaining file work, and verify before finishing the task.',
    );
  });

  it('unknown/editor-asleep, canWake undefined — the wait-it-out wording', () => {
    const text = describeCompileOutcome({ status: 'unknown', reason: 'editor-asleep' });
    expect(text).toBe(
      "Unity's window is in the background, so its editor loop is parked and it has not " +
        'reported a compile for this change. The import is queued and runs as soon as Unity ' +
        'ticks — compiler errors, if any, arrive then. This is NOT a failure: the write ' +
        'succeeded — continue with the remaining file work. Do not rewrite the file to try to ' +
        'force a compile.',
    );
  });

  it('unknown/editor-asleep, canWake:true — same wait-it-out wording', () => {
    const text = describeCompileOutcome({ status: 'unknown', reason: 'editor-asleep', canWake: true });
    expect(text).toContain('as soon as Unity ticks');
    expect(text).not.toContain('focuses the Unity window');
  });

  it('unknown/editor-asleep, canWake:false — the focus-Unity wording', () => {
    const text = describeCompileOutcome({ status: 'unknown', reason: 'editor-asleep', canWake: false });
    expect(text).toBe(
      "Unity's window is in the background, so its editor loop is parked and it has not " +
        'reported a compile for this change. This build of the bridge cannot wake Unity ' +
        'without focus, so the compile will not run until someone focuses the Unity window. ' +
        'This is NOT a failure: the write succeeded — continue with the remaining file work. ' +
        'Do not rewrite the file to try to force a compile.',
    );
  });

  it('never emits the [Unity compile] marker itself — callers own their own framing', () => {
    const outcomes: CompileWaitOutcome[] = [
      { status: 'no-compile' },
      { status: 'unknown', reason: 'timeout' },
      { status: 'unknown', reason: 'bridge-lost' },
      { status: 'unknown', reason: 'editor-asleep' },
      errorReport([]),
    ];
    for (const o of outcomes) {
      expect(describeCompileOutcome(o)).not.toContain('[Unity compile]');
    }
  });
});
