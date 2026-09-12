// The New Input System couples C# to the asset through STRINGS, so none of
// these bugs produce a compiler error. The tests care most about two things:
// that a broken literal IS reported, and that a correct one is NOT -- a false
// positive here would be noise on every valid input script in the project.

import { describe, it, expect, beforeEach } from 'bun:test';
import { scanCSharp } from '../services/csharp-scan';
import { inputActionsRule } from './input-actions';
import {
  buildInputActionsIndex,
  __setInputActionsIndexForTest,
} from '../services/inputactions-cache';

const ASSET = JSON.stringify({
  name: 'PlayerControls',
  maps: [
    {
      name: 'Player',
      id: 'm1',
      actions: [
        { name: 'Move', type: 'Value', id: 'a1', expectedControlType: 'Vector2' },
        { name: 'Jump', type: 'Button', id: 'a2', expectedControlType: 'Button' },
        { name: 'Interact', type: 'Button', id: 'a3', expectedControlType: 'Button' },
        { name: 'Reload', type: 'Button', id: 'a4', expectedControlType: 'Button' },
      ],
      bindings: [
        { id: 'b1', path: '<Gamepad>/leftStick', action: 'Move' },
        { id: 'b2', path: '<Gamepad>/buttonSouth', action: 'Jump' },
        { id: 'b3', path: '<Gamepad>/buttonWest', action: 'Interact' },
        { id: 'b4', path: '<Gamepad>/buttonWest', action: 'Reload' },
      ],
    },
    {
      name: 'UI',
      id: 'm2',
      actions: [{ name: 'Submit', type: 'Button', id: 'a5', expectedControlType: 'Button' }],
      bindings: [{ id: 'b5', path: '<Keyboard>/enter', action: 'Submit' }],
    },
  ],
});

const INDEX = buildInputActionsIndex([{ path: '/p/PlayerControls.inputactions', content: ASSET }], 'New');

function run(code: string) {
  return inputActionsRule.run(scanCSharp(code), {
    model: null,
    filePath: '/proj/Assets/T.cs',
    unityVersion: '6000.3.5f2',
    monaco: null,
  });
}
const codes = (fs: ReturnType<typeof run>) => fs.map((f) => f.code);

beforeEach(() => __setInputActionsIndexForTest(INDEX));

describe('with no snapshot loaded', () => {
  it('reports nothing rather than guessing', () => {
    __setInputActionsIndexForTest(null);
    expect(run('var a = map.FindAction("Nope");')).toEqual([]);
  });

  it('stays silent when the project has no .inputactions at all', () => {
    // A project may legitimately build every action in code with
    // `new InputAction(...)`; there is nothing to validate against.
    __setInputActionsIndexForTest(buildInputActionsIndex([], 'New'));
    expect(run('var a = map.FindAction("Nope");')).toEqual([]);
  });
});

describe('unknown action names (UNITY0401)', () => {
  it('reports a name that exists in no map', () => {
    const found = run('var a = map.FindAction("Fly");');
    expect(codes(found)).toEqual(['UNITY0401']);
    expect(found[0].message).toContain("No action named 'Fly'");
  });

  it('accepts a name that does exist', () => {
    expect(run('var a = map.FindAction("Jump");')).toEqual([]);
  });

  it('accepts a fully qualified name', () => {
    expect(run('var a = c.actions["Player/Jump"];')).toEqual([]);
  });

  it('reports a real action addressed through the wrong map, and says where it lives', () => {
    const found = run('var a = c.actions["UI/Jump"];');
    expect(codes(found)).toEqual(['UNITY0401']);
    expect(found[0].message).toContain("No action 'Jump' in map 'UI'");
    expect(found[0].message).toContain("'Player'");
  });

  it('reports an unknown action map', () => {
    const found = run('var m = controls.FindActionMap("Vehicle");');
    expect(codes(found)).toEqual(['UNITY0401']);
    expect(found[0].message).toContain('Known maps');
  });

  it('accepts a known action map', () => {
    expect(run('var m = controls.FindActionMap("Player");')).toEqual([]);
  });

  it('ignores a literal inside a comment', () => {
    expect(run('// var a = map.FindAction("Fly");')).toEqual([]);
  });

  it('ignores a matching literal that is not an action lookup', () => {
    expect(run('var s = "Fly";')).toEqual([]);
  });

  it('points the squiggle at the literal, not the whole call', () => {
    const src = 'var a = map.FindAction("Fly");';
    const found = run(src);
    expect(src.slice(found[0].start, found[0].end)).toBe('"Fly"');
  });
});

describe('binding conflicts (UNITY0403)', () => {
  it('flags the action that never fires, naming the winner and the control', () => {
    const found = run('var a = map.FindAction("Reload");');
    expect(codes(found)).toEqual(['UNITY0403']);
    expect(found[0].message).toContain('Player/Interact');
    expect(found[0].message).toContain('<Gamepad>/buttonWest');
  });

  it('does not flag the action that wins the control', () => {
    expect(run('var a = map.FindAction("Interact");')).toEqual([]);
  });
});

describe('ReadValue type mismatch (UNITY0402)', () => {
  it('reports reading a Button as Vector2', () => {
    const found = run(`
      void Awake() { sprint = player.FindAction("Jump"); }
      void Update() { var v = sprint.ReadValue<Vector2>(); }
    `);
    expect(codes(found)).toEqual(['UNITY0402']);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('ReadValue<float>()');
    expect(found[0].message).toContain('IsPressed()');
  });

  it('accepts reading a Vector2 action as Vector2', () => {
    expect(
      run(`
      void Awake() { move = player.FindAction("Move"); }
      void Update() { var v = move.ReadValue<Vector2>(); }
    `),
    ).toEqual([]);
  });

  it('accepts reading a Button as float', () => {
    expect(
      run(`
      void Awake() { jump = player.FindAction("Jump"); }
      void Update() { var v = jump.ReadValue<float>(); }
    `),
    ).toEqual([]);
  });

  it('resolves a fully qualified type argument', () => {
    expect(
      run(`
      void Awake() { move = player.FindAction("Move"); }
      void Update() { var v = move.ReadValue<UnityEngine.Vector2>(); }
    `),
    ).toEqual([]);
  });

  it('says nothing about a local it never saw assigned from an action', () => {
    expect(run('void Update() { var v = mystery.ReadValue<Vector2>(); }')).toEqual([]);
  });
});
