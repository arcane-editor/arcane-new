import { describe, expect, it } from 'bun:test';
import { isLoadFinishedMessage, isLoadStartedMessage } from './csharp-ls-log-markers';

// These strings are protocol. The readiness gate holds every C# diagnostic
// until it sees a finish marker, so a rename upstream would not break anything
// visibly — it would just degrade the editor to its 20s failsafe timer, on
// every project load, with no error anywhere. Captured verbatim from
// csharp-ls 0.27.0 running against a real Unity project.

const LOADING = 'csharp-ls: Loading solution "C:\\Users\\me\\Game\\.unityide.sln"...';
const FINISHED = 'csharp-ls: Finished loading solution "C:\\Users\\me\\Game\\.unityide.sln"';

describe('isLoadStartedMessage', () => {
  it('recognises the solution and project load markers', () => {
    expect(isLoadStartedMessage(LOADING)).toBe(true);
    expect(isLoadStartedMessage('loading project "Assembly-CSharp"..')).toBe(true);
  });

  it('accepts the message with or without the log prefix', () => {
    // It arrives prefixed over window/logMessage and bare on stderr.
    expect(isLoadStartedMessage('Loading solution "x"...')).toBe(true);
  });

  it('does not mistake the finish marker for a start', () => {
    // Both contain "loading solution"; anchoring is what separates them.
    expect(isLoadStartedMessage(FINISHED)).toBe(false);
  });

  it('ignores unrelated log lines', () => {
    expect(isLoadStartedMessage('csharp-ls: initializing, version 0.27.0')).toBe(false);
    expect(isLoadStartedMessage('')).toBe(false);
  });
});

describe('isLoadFinishedMessage', () => {
  it('recognises the solution and project finish markers', () => {
    expect(isLoadFinishedMessage(FINISHED)).toBe(true);
    expect(isLoadFinishedMessage('Finished loading project "Assembly-CSharp"')).toBe(true);
  });

  it('does not fire on the start marker', () => {
    expect(isLoadFinishedMessage(LOADING)).toBe(false);
  });

  it('ignores unrelated log lines', () => {
    expect(isLoadFinishedMessage('csharp-ls: MSBuildLocator: will register …')).toBe(false);
    expect(isLoadFinishedMessage('')).toBe(false);
  });
});
