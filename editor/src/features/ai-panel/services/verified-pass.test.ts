import { describe, it, expect, beforeEach } from 'bun:test';
import {
  beginVerifiedPass,
  recordTouchedFile,
  touchedFileCount,
  runVerifiedPass,
  type VerifiedPassDeps,
} from './verified-pass';
import type { Finding } from '../../unity-analyzers';
import type { CompilationPayload } from '../../../types/unity';

const WORKSPACE = '/proj';

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    ruleId: 'unity.getComponentInUpdate',
    message: 'GetComponent called in Update',
    severity: 'error',
    start: 0,
    end: 1,
    ...overrides,
  };
}

function fakeDeps(overrides: Partial<VerifiedPassDeps> = {}): VerifiedPassDeps {
  return {
    readFile: async () => 'class Foo {}',
    runAnalyzers: () => [],
    bridgeConnected: () => false,
    triggerRecompile: async () => ({ status: 'unknown', reason: 'timeout' } as const),
    readGuid: async () => 'abc123',
    // The three subsystem steps default to `'skipped'` here so the existing
    // cases keep asserting exactly what they always did; the cases that care
    // override them.
    checkUiToolkit: async () => 'skipped',
    checkScriptableObjects: async () => 'skipped',
    checkInput: async () => 'skipped',
    ...overrides,
  };
}

describe('verified-pass registry', () => {
  beforeEach(() => {
    beginVerifiedPass();
  });

  it('starts empty and grows as files are recorded', () => {
    expect(touchedFileCount()).toBe(0);
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    expect(touchedFileCount()).toBe(1);
    recordTouchedFile('/proj/Assets/Scripts/Bar.cs');
    expect(touchedFileCount()).toBe(2);
  });

  it('dedupes the same file touched more than once', () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    expect(touchedFileCount()).toBe(1);
  });

  it('resets per send', () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    expect(touchedFileCount()).toBe(1);
    beginVerifiedPass();
    expect(touchedFileCount()).toBe(0);
  });
});

describe('runVerifiedPass', () => {
  beforeEach(() => {
    beginVerifiedPass();
  });

  it('reports an all-clean card when nothing is wrong and the bridge is connected', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs.meta');

    const report: CompilationPayload = { started: false, success: true, errors: 0, messages: [] };
    const deps = fakeDeps({
      bridgeConnected: () => true,
      triggerRecompile: async () => ({ status: 'report', report } as const),
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.files).toBe(2);
    expect(data.touchedFiles.sort()).toEqual(
      ['Assets/Scripts/Foo.cs', 'Assets/Scripts/Foo.cs.meta'].sort(),
    );
    expect(data.analyzers).toEqual({ errors: 0 });
    expect(data.compile).toBe('clean');
    expect(data.guids).toBe('intact');
  });

  it('counts error-severity analyzer findings across touched .cs files', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    recordTouchedFile('/proj/Assets/Scripts/Bar.cs');

    const deps = fakeDeps({
      runAnalyzers: (_text, filePath) =>
        filePath.endsWith('Foo.cs')
          ? [finding({ severity: 'error' }), finding({ severity: 'warning' })]
          : [finding({ severity: 'error' })],
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.analyzers).toEqual({ errors: 2 });
  });

  it('reports compile as skipped when the bridge is not connected', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');

    let triggerCalled = false;
    const deps = fakeDeps({
      bridgeConnected: () => false,
      triggerRecompile: async () => {
        triggerCalled = true;
        return { status: 'unknown', reason: 'timeout' } as const;
      },
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.compile).toBe('skipped');
    expect(triggerCalled).toBe(false);
  });

  it('reports compile errors when the bridge returns compiler errors', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');

    const report: CompilationPayload = {
      started: false,
      success: false,
      errors: 2,
      messages: [
        { file: 'Assets/Scripts/Foo.cs', line: 3, column: 1, message: 'boom', type: 'Error' },
        { file: 'Assets/Scripts/Foo.cs', line: 8, column: 1, message: 'bang', type: 'Error' },
        { file: 'Assets/Scripts/Foo.cs', line: 1, column: 1, message: 'meh', type: 'Warning' },
      ],
    };
    const deps = fakeDeps({
      bridgeConnected: () => true,
      triggerRecompile: async () => ({ status: 'report', report } as const),
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.compile).toEqual({ errors: 2 });
  });

  it('reports guid integrity as missing for a touched .cs under Assets/ with no readable meta', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    recordTouchedFile('/proj/Assets/Scripts/Bar.cs');

    const deps = fakeDeps({
      readGuid: async (absPath) => (absPath.endsWith('Bar.cs') ? null : 'guid-1'),
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.guids).toEqual({ missing: ['Assets/Scripts/Bar.cs'] });
  });

  it('skips the guid check for touched .cs files outside Assets/', async () => {
    recordTouchedFile('/proj/Tools/Editor/Helper.cs');

    let guidCalled = false;
    const deps = fakeDeps({
      readGuid: async () => {
        guidCalled = true;
        return null;
      },
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.guids).toBe('intact');
    expect(guidCalled).toBe(false);
  });

  it('degrades a throwing step to skipped without breaking the other steps', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');

    const deps = fakeDeps({
      runAnalyzers: () => {
        throw new Error('analyzer engine exploded');
      },
      bridgeConnected: () => true,
      triggerRecompile: async () => ({ status: 'report', report: { started: false, success: true, errors: 0, messages: [] } } as const),
      readGuid: async () => 'guid-1',
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.analyzers).toBe('skipped');
    expect(data.compile).toBe('clean');
    expect(data.guids).toBe('intact');
  });

  it('degrades the compile step to skipped when triggerRecompile throws', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');

    const deps = fakeDeps({
      bridgeConnected: () => true,
      triggerRecompile: async () => {
        throw new Error('bridge dropped');
      },
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.compile).toBe('skipped');
    expect(data.analyzers).toEqual({ errors: 0 });
  });

  it('degrades the guid step to skipped when readGuid throws', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');

    const deps = fakeDeps({
      readGuid: async () => {
        throw new Error('meta read exploded');
      },
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(data.guids).toBe('skipped');
  });

  it('only counts .cs files touched for the analyzer step, ignoring other extensions', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    recordTouchedFile('/proj/Assets/Scenes/Level1.unity');

    const seen: string[] = [];
    const deps = fakeDeps({
      runAnalyzers: (_text, filePath) => {
        seen.push(filePath);
        return [];
      },
    });

    const data = await runVerifiedPass(WORKSPACE, deps);

    expect(seen).toEqual(['/proj/Assets/Scripts/Foo.cs']);
    expect(data.files).toBe(2);
  });

  it('reflects the registry reset between two consecutive sends', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    const deps = fakeDeps();
    const first = await runVerifiedPass(WORKSPACE, deps);
    expect(first.files).toBe(1);

    beginVerifiedPass();
    recordTouchedFile('/proj/Assets/Scripts/Bar.cs');
    recordTouchedFile('/proj/Assets/Scripts/Baz.cs');
    const second = await runVerifiedPass(WORKSPACE, deps);
    expect(second.files).toBe(2);
    expect(second.touchedFiles.sort()).toEqual(
      ['Assets/Scripts/Bar.cs', 'Assets/Scripts/Baz.cs'].sort(),
    );
  });
});


// The three subsystems a compile can never speak for. The card's job is to say
// what was actually checked, so the cases that matter are the ones where a step
// must NOT claim a pass: nothing relevant was touched, or the step ran out of
// budget.
describe('verified-pass — the silent-failure subsystems', () => {
  beforeEach(() => {
    beginVerifiedPass();
  });

  it('reports each subsystem result on the card', async () => {
    recordTouchedFile('/proj/Assets/UI/HUD.uxml');
    const card = await runVerifiedPass(
      WORKSPACE,
      fakeDeps({
        checkUiToolkit: async () => ({ queriesResolved: 11, queriesTotal: 12, problems: 2 }),
        checkScriptableObjects: async () => ({ drift: 3 }),
        checkInput: async () => 'clean',
      }),
    );
    expect(card.uiToolkit).toEqual({ queriesResolved: 11, queriesTotal: 12, problems: 2 });
    expect(card.scriptableObjects).toEqual({ drift: 3 });
    expect(card.input).toBe('clean');
  });

  it('passes the touched files and the workspace to every step', async () => {
    recordTouchedFile('/proj/Assets/UI/HUD.uxml');
    let seen: { files: string[]; ws: string } | undefined;
    await runVerifiedPass(
      WORKSPACE,
      fakeDeps({
        checkUiToolkit: async (files, ws) => {
          seen = { files, ws };
          return 'clean';
        },
      }),
    );
    expect(seen).toEqual({ files: ['/proj/Assets/UI/HUD.uxml'], ws: WORKSPACE });
  });

  it('degrades a throwing step to skipped rather than failing the pass', async () => {
    recordTouchedFile('/proj/Assets/UI/HUD.uxml');
    const card = await runVerifiedPass(
      WORKSPACE,
      fakeDeps({
        checkUiToolkit: async () => {
          throw new Error('snapshot unavailable');
        },
        checkInput: async () => 'clean',
      }),
    );
    expect(card.uiToolkit).toBe('skipped');
    // The other steps still ran — one failure must not take the card down.
    expect(card.input).toBe('clean');
  });

  it('never reports a subsystem as clean when the step said skipped', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    const card = await runVerifiedPass(WORKSPACE, fakeDeps());
    expect(card.uiToolkit).toBe('skipped');
    expect(card.scriptableObjects).toBe('skipped');
    expect(card.input).toBe('skipped');
  });
});

// Task 13. The console and tests rows exist on the card, but the sweep itself
// never fills them in: the check runs a SECOND `runVerifiedPass()` after its
// one repair attempt, and only `agent-service.ts` can see both halves. A pass
// that guessed here would put a console verdict on a card that never read the
// console.
describe('runVerifiedPass — the console/tests rows are the caller\'s to fill', () => {
  beforeEach(() => beginVerifiedPass());

  it('always reports them as skipped, whatever else the sweep found', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    const data = await runVerifiedPass(WORKSPACE, fakeDeps());
    expect(data.console).toBe('skipped');
    expect(data.tests).toBe('skipped');
    expect(data.repair).toBeUndefined();
  });

  it('reports them as skipped for a clean, fully-successful sweep too', async () => {
    recordTouchedFile('/proj/Assets/Scripts/Foo.cs');
    const data = await runVerifiedPass(
      WORKSPACE,
      fakeDeps({
        bridgeConnected: () => true,
        triggerRecompile: async () => ({ status: 'report', report: { started: false, messages: [] } }) as never,
      }),
    );
    expect(data.compile).toBe('clean');
    expect(data.console).toBe('skipped');
    expect(data.tests).toBe('skipped');
  });
});
