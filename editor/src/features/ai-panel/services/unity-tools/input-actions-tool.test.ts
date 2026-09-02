// The tool exists to stop the agent GUESSING action names, so the cases that
// matter most are the ones where it must refuse to guess: a missing action has
// to come back with the real list attached, and a legacy project has to be
// told the Input System APIs do not exist rather than being handed an empty
// listing it might read as "no actions, invent one".
//
// Note the fixture is built from `utils/inputactions-index`, not from the
// analyzers barrel. That is the DOM-less guard: the barrel pulls Monaco and the
// theme store, so importing it here dies on `ReferenceError: document is not
// defined` — which is also why the tool reaches its features through a dynamic
// import at call time rather than a static one.

import { describe, it, expect } from 'bun:test';
import { buildInputActionsIndex } from '../../../../utils/inputactions-index';
import type { ActionReference } from '../../../unity-input';
import { createUnityInputActionsTool, type InputActionsToolDeps } from './input-actions-tool';

const WS = '/proj';

const ASSET = JSON.stringify({
  name: 'PlayerControls',
  maps: [
    {
      name: 'Player',
      id: 'm1',
      actions: [
        { name: 'Move', type: 'Value', id: 'a1', expectedControlType: 'Vector2' },
        { name: 'Jump', type: 'Button', id: 'a2', expectedControlType: 'Button' },
      ],
      bindings: [
        { id: 'b1', path: '<Gamepad>/leftStick', action: 'Move', groups: 'Gamepad' },
        { id: 'b2', path: '<Keyboard>/space', action: 'Jump', groups: 'Keyboard&Mouse' },
      ],
    },
    {
      name: 'UI',
      id: 'm2',
      actions: [{ name: 'Submit', type: 'Button', id: 'a3', expectedControlType: 'Button' }],
      bindings: [{ id: 'b3', path: '<Keyboard>/enter', action: 'Submit' }],
    },
  ],
});

const NEW_INDEX = buildInputActionsIndex(
  [{ path: `${WS}/Assets/PlayerControls.inputactions`, content: ASSET }],
  'New',
);

const REFS: ActionReference[] = [
  {
    filePath: `${WS}/Assets/Scripts/PlayerController.cs`,
    line: 24,
    column: 9,
    kind: 'subscription',
    actionName: 'Jump',
    qualifiedName: null,
    snippet: 'jump.performed += OnJump;',
    handler: 'OnJump',
    phase: 'performed',
  },
  {
    filePath: `${WS}/Assets/Scripts/PlayerController.cs`,
    line: 41,
    column: 10,
    kind: 'handler',
    actionName: 'Jump',
    qualifiedName: null,
    snippet: 'void OnJump(InputAction.CallbackContext ctx)',
    handler: 'OnJump',
  },
];

function deps(over: Partial<InputActionsToolDeps> = {}): InputActionsToolDeps {
  return {
    loadIndex: async () => NEW_INDEX,
    findRefs: async () => new Map([['Jump', REFS]]),
    ...over,
  };
}

async function run(params: object, over?: Partial<InputActionsToolDeps>): Promise<string> {
  const tool = createUnityInputActionsTool(WS, deps(over));
  const result = await tool.execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('unity_input_actions — inventory', () => {
  it('lists every map with its actions, types and bindings', async () => {
    const out = await run({});
    expect(out).toContain('Player (2 actions)');
    expect(out).toContain('UI (1 action)');
    expect(out).toContain('Move  —  Value, reads as Vector2');
    expect(out).toContain('<Keyboard>/space');
  });

  it('reports paths relative to the workspace, not absolute', async () => {
    const out = await run({});
    expect(out).toContain('Assets/PlayerControls.inputactions');
    expect(out).not.toContain(`${WS}/Assets/PlayerControls.inputactions`);
  });

  it('filters to one map, and names the real maps when the filter misses', async () => {
    expect(await run({ map: 'Player' })).not.toContain('UI (');
    const miss = await run({ map: 'Nope' });
    expect(miss).toContain('No action map named "Nope"');
    expect(miss).toContain('Player');
  });
});

describe('unity_input_actions — one action', () => {
  it('resolves a bare name and reports the control type ReadValue must match', async () => {
    const out = await run({ action: 'Move' });
    expect(out).toContain('Player/Move');
    expect(out).toContain('reads as: Vector2');
  });

  it('accepts the qualified name too', async () => {
    expect(await run({ action: 'Player/Jump' })).toContain('Player/Jump');
  });

  it('corrects a case-only miss instead of reporting the action missing', async () => {
    expect(await run({ action: 'jump' })).toContain('Player/Jump');
  });

  it('refuses to invent an unknown action, and attaches the real list', async () => {
    const out = await run({ action: 'Sprint' });
    expect(out).toContain('No action named "Sprint"');
    expect(out).toContain('Do NOT invent it');
    expect(out).toContain('Player/Jump');
  });

  it('names the method that runs when the action fires', async () => {
    const out = await run({ action: 'Jump', refs: true });
    expect(out).toContain('runs when it fires — OnJump()');
    expect(out).toContain('Assets/Scripts/PlayerController.cs:41');
  });

  it('says so plainly when nothing in the project reads the action', async () => {
    const out = await run({ action: 'Move', refs: true }, { findRefs: async () => new Map() });
    expect(out).toContain('No C# references');
  });

  it('does not scan for references unless asked', async () => {
    let called = false;
    await run(
      { action: 'Jump' },
      {
        findRefs: async () => {
          called = true;
          return new Map();
        },
      },
    );
    expect(called).toBe(false);
  });
});

describe('unity_input_actions — projects without the Input System', () => {
  it('tells a legacy project the Input System APIs are unavailable', async () => {
    const legacy = buildInputActionsIndex([], 'Legacy');
    const out = await run({}, { loadIndex: async () => legacy });
    expect(out).toContain('legacy Input Manager');
    expect(out).toContain('Input.GetAxis');
    expect(out).toContain('unity_plan_migration');
  });

  it('distinguishes "no asset" from "no actions" when the package is active', async () => {
    const none = buildInputActionsIndex([], 'New');
    const out = await run({}, { loadIndex: async () => none });
    expect(out).toContain('no .inputactions asset');
    expect(out).toContain('rather than inventing action names');
  });

  it('degrades to a read-tool hint when the snapshot cannot be built', async () => {
    const out = await run(
      {},
      {
        loadIndex: async () => {
          throw new Error('scan failed');
        },
      },
    );
    expect(out).toContain('read tool');
  });

  it('answers rather than throwing when the cache stays cold', async () => {
    const out = await run({}, { loadIndex: async () => null });
    expect(out).toContain('No input snapshot');
  });
});
