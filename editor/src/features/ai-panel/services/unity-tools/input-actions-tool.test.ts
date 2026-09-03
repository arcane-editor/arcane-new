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
import {
  createUnityInputActionsTool,
  type InputActionsToolDeps,
  type ActionRefsResult,
} from './input-actions-tool';

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

const NO_REFS: ActionRefsResult = {
  byActionName: new Map(),
  usesInputActionReference: false,
};

function refsResult(map: Map<string, ActionReference[]>, suppressed = false): ActionRefsResult {
  return { byActionName: map, usesInputActionReference: suppressed };
}

function deps(over: Partial<InputActionsToolDeps> = {}): InputActionsToolDeps {
  return {
    loadIndex: async () => NEW_INDEX,
    findRefs: async () => refsResult(new Map([['Jump', REFS]])),
    loadAssetContext: async () => ({ wrapper: null, assetReferencedByScene: false }),
    coverage: async () => null,
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
    const out = await run({ action: 'Move', refs: true }, { findRefs: async () => NO_REFS });
    expect(out).toContain('No C# references');
  });

  it('does not scan for references unless asked', async () => {
    let called = false;
    await run(
      { action: 'Jump' },
      {
        findRefs: async () => {
          called = true;
          return NO_REFS;
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


// The blind spots this tool had until the graph work landed in the panel. Each
// one made the tool answer confidently and wrongly, which is worse than not
// answering: a wrong "nothing reads this" invites deleting a live action.
describe('unity_input_actions — the wrapper', () => {
  const withWrapper = {
    loadAssetContext: async () => ({
      wrapper: { className: 'PlayerControls', path: null },
      assetReferencedByScene: false,
    }),
  };

  it('names the generated class in the inventory, and the idiom it implies', async () => {
    const out = await run({}, withWrapper);
    expect(out).toContain('class PlayerControls');
    expect(out).toContain('Prefer it over FindAction here');
  });

  it('gives the exact wrapper property for one action', async () => {
    const out = await run({ action: 'Jump' }, withWrapper);
    expect(out).toContain('PlayerControls.Player.Jump');
  });

  it('sanitises the property the way Unity does, so the name it prints exists', async () => {
    const spaced = buildInputActionsIndex(
      [
        {
          path: `${WS}/Assets/PlayerControls.inputactions`,
          content: JSON.stringify({
            name: 'PlayerControls',
            maps: [
              {
                name: 'Player Two',
                id: 'm1',
                actions: [{ name: 'Move Camera', type: 'Value', id: 'a1' }],
                bindings: [{ id: 'b1', path: '<Mouse>/delta', action: 'Move Camera' }],
              },
            ],
          }),
        },
      ],
      'New',
    );
    const out = await run(
      { action: 'Move Camera' },
      { ...withWrapper, loadIndex: async () => spaced },
    );
    expect(out).toContain('PlayerControls.PlayerTwo.MoveCamera');
  });

  it('says nothing about a wrapper when the asset does not generate one', async () => {
    expect(await run({})).not.toContain('wrapper');
  });
});

describe('unity_input_actions — "nothing reads this" is the claim that must not be wrong', () => {
  it('reports unread only when nothing could be hiding a reader', async () => {
    const out = await run({ action: 'Move', refs: true }, { findRefs: async () => NO_REFS });
    expect(out).toContain('defined in the asset but unread');
  });

  it('downgrades to unknown when the project wires InputActionReference fields', async () => {
    const out = await run(
      { action: 'Move', refs: true },
      { findRefs: async () => refsResult(new Map(), true) },
    );
    expect(out).toContain('unknown, not unused');
    expect(out).not.toContain('but unread');
  });

  it('downgrades to unknown when a scene or prefab references the asset', async () => {
    const out = await run(
      { action: 'Move', refs: true },
      {
        findRefs: async () => NO_REFS,
        loadAssetContext: async () => ({ wrapper: null, assetReferencedByScene: true }),
      },
    );
    expect(out).toContain('unknown, not unused');
  });

  it('passes every action to the scan, so the wrapper catalog is complete', async () => {
    let seen: Array<{ name: string; mapName: string }> = [];
    await run(
      { action: 'Jump', refs: true },
      {
        findRefs: async (_ws, actions) => {
          seen = actions;
          return NO_REFS;
        },
      },
    );
    expect(seen.map((a) => a.name).sort()).toEqual(['Jump', 'Move', 'Submit']);
  });
});

describe('unity_input_actions — control-scheme coverage', () => {
  it('lists the schemes an action cannot be triggered in', async () => {
    const out = await run(
      { coverage: true },
      {
        coverage: async () => ({
          schemes: ['Keyboard&Mouse', 'Gamepad'],
          rows: [
            { qualifiedName: 'Player/Move', bound: ['Gamepad'], missing: ['Keyboard&Mouse'] },
            { qualifiedName: 'Player/Jump', bound: ['Keyboard&Mouse', 'Gamepad'], missing: [] },
          ],
        }),
      },
    );
    expect(out).toContain('Player/Move — missing: Keyboard&Mouse');
    expect(out).not.toContain('Player/Jump —');
  });

  it('says so plainly when every action is covered', async () => {
    const out = await run(
      { coverage: true },
      {
        coverage: async () => ({
          schemes: ['Keyboard&Mouse'],
          rows: [{ qualifiedName: 'Player/Jump', bound: ['Keyboard&Mouse'], missing: [] }],
        }),
      },
    );
    expect(out).toContain('bound in every control scheme');
  });

  it('does not claim coverage for an asset that declares no schemes', async () => {
    const out = await run({ coverage: true }, { coverage: async () => ({ schemes: [], rows: [] }) });
    expect(out).toContain('declares no control schemes');
  });
});
