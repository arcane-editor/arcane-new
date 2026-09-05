// The round-trip is the safety property: the ids Unity matches bindings by must
// survive every operation, and everything not deliberately changed must come
// back identical. The other thing worth pinning is that a new binding on a
// contested control REPORTS the conflict — that is the failure the subsystem
// exists to surface, and it is invisible in Unity.

import { describe, it, expect } from 'bun:test';
import { createUnityInputEditTool, type InputEditToolDeps } from './input-edit-tool';
import { parseInputActions } from '../../../../utils/inputactions-model';

const PATH = 'Assets/Controls.inputactions';

const SOURCE = JSON.stringify(
  {
    name: 'Controls',
    maps: [
      {
        name: 'Player',
        id: 'map-1',
        actions: [{ name: 'Jump', type: 'Button', id: 'act-1', expectedControlType: 'Button' }],
        bindings: [
          {
            name: '',
            id: 'bind-1',
            path: '<Keyboard>/space',
            interactions: '',
            processors: '',
            groups: '',
            action: 'Jump',
            isComposite: false,
            isPartOfComposite: false,
          },
        ],
      },
    ],
    controlSchemes: [],
  },
  null,
  4,
);

function harness(source = SOURCE) {
  const written: Array<{ path: string; content: string }> = [];
  const notified: string[] = [];
  const deps: InputEditToolDeps = {
    readFile: async () => source,
    writeFile: async (path, content) => {
      written.push({ path, content });
    },
    onWrite: (p) => notified.push(p),
  };
  return { written, notified, deps };
}

async function run(params: object, deps: InputEditToolDeps): Promise<string> {
  const result = await createUnityInputEditTool(deps).execute('id', params);
  return result.content[0]?.type === 'text' ? result.content[0].text : '';
}

describe('unity_input_edit — add-action', () => {
  it('adds the action and reports how to reach it from C#', async () => {
    const { written, deps } = harness();
    const out = await run(
      {
        path: PATH,
        operation: 'add-action',
        map: 'Player',
        action: 'Sprint',
        expectedControlType: 'Button',
        controlPaths: ['<Keyboard>/leftShift'],
      },
      deps,
    );
    expect(out).toContain('Added action Player/Sprint');
    expect(out).toContain('FindAction("Player/Sprint")');
    expect(out).toContain('ReadValue<Button>');

    const doc = parseInputActions(written[0].content).doc!;
    expect(doc.maps[0].actions.map((a) => a.name)).toEqual(['Jump', 'Sprint']);
    expect(doc.maps[0].bindings).toHaveLength(2);
  });

  it('leaves every existing id untouched', async () => {
    const { written, deps } = harness();
    await run({ path: PATH, operation: 'add-action', map: 'Player', action: 'Sprint' }, deps);
    const doc = parseInputActions(written[0].content).doc!;
    expect(doc.maps[0].id).toBe('map-1');
    expect(doc.maps[0].actions[0].id).toBe('act-1');
    expect(doc.maps[0].bindings[0].id).toBe('bind-1');
  });

  it('warns when an action is added with no expectedControlType', async () => {
    const { deps } = harness();
    const out = await run({ path: PATH, operation: 'add-action', map: 'Player', action: 'Sprint' }, deps);
    expect(out).toContain('ReadValue<T> is unchecked');
  });

  it('mentions that the generated wrapper is stale until Unity refreshes', async () => {
    const { deps } = harness();
    const out = await run({ path: PATH, operation: 'add-action', map: 'Player', action: 'Sprint' }, deps);
    expect(out).toContain('regenerates it on the next asset refresh');
  });

  it('writes nothing when the map does not exist', async () => {
    const { written, deps } = harness();
    const out = await run({ path: PATH, operation: 'add-action', map: 'UI', action: 'Submit' }, deps);
    expect(out).toContain('Nothing changed');
    expect(written).toHaveLength(0);
  });
});

describe('unity_input_edit — add-binding', () => {
  it('binds a control and reports it', async () => {
    const { written, deps } = harness();
    const out = await run(
      {
        path: PATH,
        operation: 'add-binding',
        map: 'Player',
        action: 'Jump',
        controlPath: '<Gamepad>/buttonSouth',
        groups: ['Gamepad'],
      },
      deps,
    );
    expect(out).toContain('Bound <Gamepad>/buttonSouth to Player/Jump');
    const doc = parseInputActions(written[0].content).doc!;
    expect(doc.maps[0].bindings[1].groups).toBe('Gamepad');
  });

  it('surfaces a starved action when the new binding contests a control', async () => {
    const { deps } = harness();
    const out = await run(
      {
        path: PATH,
        operation: 'add-action',
        map: 'Player',
        action: 'Fire',
        controlPaths: ['<Keyboard>/space'],
      },
      deps,
    );
    expect(out).toContain('Binding conflicts now present');
    expect(out).toContain('<Keyboard>/space');
  });

  it('requires the arguments the operation actually needs', async () => {
    const { deps } = harness();
    expect(await run({ path: PATH, operation: 'add-binding', map: 'Player' }, deps)).toContain(
      'needs `map`, `action` and `controlPath`',
    );
  });
});

describe('unity_input_edit — set-binding-path', () => {
  it('rebinds by id', async () => {
    const { written, deps } = harness();
    const out = await run(
      { path: PATH, operation: 'set-binding-path', bindingId: 'bind-1', controlPath: '<Keyboard>/enter' },
      deps,
    );
    expect(out).toContain('Rebound bind-1');
    expect(parseInputActions(written[0].content).doc!.maps[0].bindings[0].path).toBe(
      '<Keyboard>/enter',
    );
  });

  it('refuses an unknown binding id instead of writing an unchanged file', async () => {
    const { written, deps } = harness();
    const out = await run(
      { path: PATH, operation: 'set-binding-path', bindingId: 'nope', controlPath: '<Keyboard>/x' },
      deps,
    );
    expect(out).toContain('No binding with id "nope"');
    expect(out).toContain('unity_input_actions');
    expect(written).toHaveLength(0);
  });
});

describe('unity_input_edit — refusals', () => {
  it('refuses to touch an asset that does not parse', async () => {
    const { written, deps } = harness('{ not json');
    const out = await run({ path: PATH, operation: 'add-action', map: 'Player', action: 'X' }, deps);
    expect(out).toContain('does not parse');
    expect(out).toContain('Unity cannot load it either');
    expect(written).toHaveLength(0);
  });

  it('reports the write only after one succeeded', async () => {
    const { notified, deps } = harness();
    await run({ path: PATH, operation: 'set-binding-path', bindingId: 'nope', controlPath: '<Keyboard>/x' }, deps);
    expect(notified).toEqual([]);
    await run({ path: PATH, operation: 'add-action', map: 'Player', action: 'Sprint' }, deps);
    expect(notified).toEqual([PATH]);
  });
});
