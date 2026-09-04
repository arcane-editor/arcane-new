import { describe, it, expect } from 'bun:test';
import {
  CONTEXT_LINES,
  FIX_PROMPT_MAX_FRAMES,
  REPAIR_MAX_FRAMES,
  CONSOLE_CHECK_MARKER,
  buildRegions,
  buildConsoleRepairPrompt,
  buildFixPrompt,
  projectFramesOf,
  isProjectFrame,
  type RegionDeps,
} from './console-repair';
import type { StackFrame } from '../../../../types/unity';

const FILE_LINES = Array.from({ length: 60 }, (_, i) => `line ${i + 1}`).join('\n');

function deps(overrides: Partial<RegionDeps> = {}): RegionDeps {
  return {
    readFile: async () => FILE_LINES,
    workspacePath: '/proj',
    ...overrides,
  };
}

const frame = (filePath: string, lineNumber: number): StackFrame => ({
  className: 'Player',
  methodName: 'Update',
  filePath,
  lineNumber,
});

describe('buildRegions', () => {
  it('embeds ±CONTEXT_LINES around the frame, 1-based and numbered', async () => {
    const [region] = await buildRegions([frame('Assets/Scripts/Player.cs', 30)], deps());
    expect(region).toStartWith('<region path="Assets/Scripts/Player.cs" line="30">\n');
    expect(region).toEndWith('\n</region>');
    // 30 - 1 - 12 = 17 (0-based) → line 18; 30 + 12 = 42 → line 42.
    expect(region).toContain('18: line 18');
    expect(region).toContain('42: line 42');
    expect(region).not.toContain('17: line 17');
    expect(region).not.toContain('43: line 43');
    expect(CONTEXT_LINES).toBe(12);
  });

  it('clamps at the start and end of the file rather than reading past it', async () => {
    const [top] = await buildRegions([frame('Assets/A.cs', 2)], deps());
    expect(top).toContain('1: line 1');
    const [bottom] = await buildRegions([frame('Assets/A.cs', 59)], deps());
    expect(bottom).toContain('60: line 60');
    expect(bottom).not.toContain('61:');
  });

  it('absolutizes a project-relative path against the workspace, and leaves an absolute one alone', async () => {
    const seen: string[] = [];
    await buildRegions([frame('Assets/A.cs', 3), frame('/elsewhere/B.cs', 3)], {
      readFile: async (p) => {
        seen.push(p);
        return FILE_LINES;
      },
      workspacePath: '/proj',
    });
    expect(seen).toEqual(['/proj/Assets/A.cs', '/elsewhere/B.cs']);
  });

  it('drops a frame whose file cannot be read instead of failing the whole prompt', async () => {
    const regions = await buildRegions([frame('Assets/A.cs', 3), frame('Assets/B.cs', 3)], {
      readFile: async (p) => {
        if (p.endsWith('B.cs')) throw new Error('ENOENT');
        return FILE_LINES;
      },
      workspacePath: '/proj',
    });
    expect(regions).toHaveLength(1);
    expect(regions[0]).toContain('Assets/A.cs');
  });

  it('collapses duplicate path:line pairs so the same lines are never embedded twice', async () => {
    const regions = await buildRegions(
      [frame('Assets/A.cs', 3), frame('Assets/A.cs', 3), frame('Assets/A.cs', 9)],
      deps(),
    );
    expect(regions).toHaveLength(2);
  });
});

describe('projectFramesOf', () => {
  it('keeps only in-Assets frames, already-parsed ones preferred', () => {
    const frames = projectFramesOf(
      {
        logType: 'Exception',
        message: 'boom',
        parsedFrames: [
          frame('/usr/lib/Packages/Thing.cs', 1),
          frame('Assets/Scripts/Player.cs', 42),
        ],
      },
      REPAIR_MAX_FRAMES,
    );
    expect(frames).toHaveLength(1);
    expect(frames[0].filePath).toBe('Assets/Scripts/Player.cs');
  });

  it('parses the raw stack trace when no frames were pre-parsed, and caps at max', () => {
    const trace = [
      'Player.Update () (at Assets/Scripts/Player.cs:42)',
      'Player.Tick () (at Assets/Scripts/Player.cs:50)',
      'Player.Late () (at Assets/Scripts/Player.cs:60)',
    ].join('\n');
    expect(projectFramesOf({ logType: 'Error', message: 'x', stackTrace: trace }, 2)).toHaveLength(2);
    expect(
      projectFramesOf({ logType: 'Error', message: 'x', stackTrace: trace }, FIX_PROMPT_MAX_FRAMES),
    ).toHaveLength(3);
  });

  it('treats an engine/package frame as not-a-project frame', () => {
    expect(isProjectFrame({ filePath: 'Assets/Scripts/A.cs' })).toBe(true);
    expect(isProjectFrame({ filePath: 'Library/PackageCache/com.unity.x/Runtime/B.cs' })).toBe(false);
  });
});

describe('buildConsoleRepairPrompt', () => {
  const problem = {
    logType: 'Exception' as const,
    firstLine: 'NullReferenceException: Object reference not set',
    location: 'Assets/Scripts/Player.cs:42',
    count: 3,
    external: false,
  };

  it('opens with the [Console check] marker so compaction never elides it', () => {
    const text = buildConsoleRepairPrompt({ console: [problem], compile: [], tests: [], regions: [] });
    expect(text).toStartWith(CONSOLE_CHECK_MARKER);
    expect(CONSOLE_CHECK_MARKER).toBe('[Console check]');
  });

  it('lists each console problem with its type, first line, location and repeat count', () => {
    const text = buildConsoleRepairPrompt({ console: [problem], compile: [], tests: [], regions: [] });
    expect(text).toContain('New console errors (1):');
    expect(text).toContain(
      '- [Exception] NullReferenceException: Object reference not set (Assets/Scripts/Player.cs:42) ×3',
    );
  });

  it('omits the repeat count when a problem was seen once', () => {
    const text = buildConsoleRepairPrompt({
      console: [{ ...problem, count: 1 }],
      compile: [],
      tests: [],
      regions: [],
    });
    expect(text).not.toContain('×');
  });

  it('marks an external problem as out of scope and tells the model to leave it alone', () => {
    const text = buildConsoleRepairPrompt({
      console: [{ ...problem, location: null, external: true }],
      compile: [],
      tests: [],
      regions: [],
    });
    expect(text).toContain('no in-project stack frame — this came from a package or the engine');
    expect(text).toContain('1 entry above came from a package or the engine');
  });

  it('lists compiler errors as file:line: message', () => {
    const text = buildConsoleRepairPrompt({
      console: [],
      compile: [{ file: 'Assets/Scripts/Foo.cs', line: 12, message: "CS0103: 'bar' does not exist" }],
      tests: [],
      regions: [],
    });
    expect(text).toContain('Compiler errors (1):');
    expect(text).toContain("- Assets/Scripts/Foo.cs:12: CS0103: 'bar' does not exist");
  });

  it('lists failed tests and tells the model to re-run them with unity_run_tests', () => {
    const text = buildConsoleRepairPrompt({
      console: [],
      compile: [],
      tests: [{ fullName: 'PlayerTests.Jumps', message: 'Expected: True  But was: False' }],
      regions: [],
    });
    expect(text).toContain('Failed tests (1):');
    expect(text).toContain('- PlayerTests.Jumps\n  Expected: True  But was: False');
    expect(text).toContain('Re-run the failed tests with `unity_run_tests`');
  });

  it('never asks for a test re-run when no test failed', () => {
    const text = buildConsoleRepairPrompt({ console: [problem], compile: [], tests: [], regions: [] });
    expect(text).not.toContain('unity_run_tests');
  });

  it('embeds the code regions and always demands evidence before a success claim', () => {
    const text = buildConsoleRepairPrompt({
      console: [problem],
      compile: [],
      tests: [],
      regions: ['<region path="Assets/Scripts/Player.cs" line="42">\n42: x\n</region>'],
    });
    expect(text).toContain('Relevant code:');
    expect(text).toContain('<region path="Assets/Scripts/Player.cs" line="42">');
    expect(text).toContain('Do not claim any of this is fixed without evidence');
  });
});

// The extraction out of `fix-console-error.ts` must not have changed one byte
// of what the model reads. This is the golden pin for the one-click flow; the
// delegation itself is pinned in `fix-console-error.test.ts`.
describe('buildFixPrompt — byte-identical to the pre-extraction prompt', () => {
  const GUIDANCE =
    `\nGuidance: if this is a NullReferenceException on a serialized field, check whether the field is simply unassigned on the object in the scene (use get_scene_hierarchy / get_game_object) BEFORE adding a null-check — that is usually the real fix. If it's a typo'd Unity message (e.g. "update" vs "Update"), fix the casing. After editing, the Unity analyzer gate will flag any remaining issues.`;

  it('renders the full prompt exactly, regions included', async () => {
    const text = await buildFixPrompt(
      {
        logType: 'Exception',
        message: 'NullReferenceException: boom',
        stackTrace: 'Player.Update () (at Assets/Scripts/Player.cs:2)',
      },
      { readFile: async () => 'a\nb\nc', workspacePath: '/proj' },
    );
    expect(text).toBe(
      [
        'Fix this Unity console exception. First state the ROOT CAUSE in 2-3 sentences, then apply the fix.',
        '',
        'Error: NullReferenceException: boom',
        '\nStack trace:\nPlayer.Update () (at Assets/Scripts/Player.cs:2)',
        '\nRelevant code:\n<region path="Assets/Scripts/Player.cs" line="2">\n1: a\n2: b\n3: c\n</region>',
        GUIDANCE,
      ].join('\n'),
    );
  });

  it('renders the no-frames fallback exactly', async () => {
    const text = await buildFixPrompt(
      { logType: 'Error', message: 'Something broke' },
      { readFile: async () => 'x', workspacePath: '/proj' },
    );
    expect(text).toBe(
      [
        'Fix this Unity console error. First state the ROOT CAUSE in 2-3 sentences, then apply the fix.',
        '',
        'Error: Something broke',
        '',
        '\n(No in-project stack frames resolved — infer from the message.)',
        GUIDANCE,
      ].join('\n'),
    );
  });
});
