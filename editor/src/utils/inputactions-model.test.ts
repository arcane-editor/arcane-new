import { describe, it, expect } from 'bun:test';
import {
  parseInputActions,
  serializeInputActions,
  listActions,
  findBindingConflicts,
  setBindingPath,
  qualifiedActionName,
} from './inputactions-model';

/**
 * A real Unity 6000.x `.inputactions` payload, 4-space indented with a
 * trailing newline exactly as Unity writes it. Two actions in `Player` share
 * `<Gamepad>/buttonWest`, which is the conflict the whole feature exists to
 * catch.
 */
const FIXTURE = `{
    "name": "PlayerControls",
    "maps": [
        {
            "name": "Player",
            "id": "8f1c2b40-0d9e-4a11-9c1a-2f0e5d3b7a01",
            "actions": [
                {
                    "name": "Move",
                    "type": "Value",
                    "id": "1a2b3c4d-0000-4000-8000-000000000001",
                    "expectedControlType": "Vector2",
                    "processors": "",
                    "interactions": "",
                    "initialStateCheck": true
                },
                {
                    "name": "Interact",
                    "type": "Button",
                    "id": "1a2b3c4d-0000-4000-8000-000000000002",
                    "expectedControlType": "Button",
                    "processors": "",
                    "interactions": "Press",
                    "initialStateCheck": false
                },
                {
                    "name": "Reload",
                    "type": "Button",
                    "id": "1a2b3c4d-0000-4000-8000-000000000003",
                    "expectedControlType": "Button",
                    "processors": "",
                    "interactions": "",
                    "initialStateCheck": false
                }
            ],
            "bindings": [
                {
                    "name": "",
                    "id": "b0000000-0000-4000-8000-000000000001",
                    "path": "<Gamepad>/leftStick",
                    "interactions": "",
                    "processors": "",
                    "groups": "Gamepad",
                    "action": "Move",
                    "isComposite": false,
                    "isPartOfComposite": false
                },
                {
                    "name": "",
                    "id": "b0000000-0000-4000-8000-000000000002",
                    "path": "<Gamepad>/buttonWest",
                    "interactions": "",
                    "processors": "",
                    "groups": "Gamepad",
                    "action": "Interact",
                    "isComposite": false,
                    "isPartOfComposite": false
                },
                {
                    "name": "",
                    "id": "b0000000-0000-4000-8000-000000000003",
                    "path": "<Gamepad>/buttonWest",
                    "interactions": "",
                    "processors": "",
                    "groups": "Gamepad",
                    "action": "Reload",
                    "isComposite": false,
                    "isPartOfComposite": false
                },
                {
                    "name": "",
                    "id": "b0000000-0000-4000-8000-000000000004",
                    "path": "<Keyboard>/r",
                    "interactions": "",
                    "processors": "",
                    "groups": "Keyboard&Mouse",
                    "action": "Reload",
                    "isComposite": false,
                    "isPartOfComposite": false
                }
            ]
        }
    ],
    "controlSchemes": [
        {
            "name": "Gamepad",
            "bindingGroup": "Gamepad",
            "devices": [
                {
                    "devicePath": "<Gamepad>",
                    "isOptional": false,
                    "isOR": false
                }
            ]
        }
    ]
}
`;

describe('parse → serialize round-trip', () => {
  it('reproduces the file byte for byte', () => {
    // The whole write path rests on this: a one-binding edit must be a
    // one-line git diff, not a reformat of the entire asset.
    const parsed = parseInputActions(FIXTURE);
    expect(serializeInputActions(parsed)).toBe(FIXTURE);
  });

  it('preserves every action and binding GUID', () => {
    const out = serializeInputActions(parseInputActions(FIXTURE));
    for (const id of FIXTURE.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g) ?? []) {
      expect(out).toContain(id);
    }
  });

  it('preserves key order within an action', () => {
    const out = serializeInputActions(parseInputActions(FIXTURE));
    const keys = [...out.matchAll(/"(name|type|id|expectedControlType)":/g)].map((m) => m[1]);
    expect(keys.slice(0, 4)).toEqual(['name', 'name', 'id', 'name']);
  });

  it('round-trips a 2-space indented file without forcing 4', () => {
    const twoSpace = '{\n  "name": "X",\n  "maps": []\n}\n';
    expect(serializeInputActions(parseInputActions(twoSpace))).toBe(twoSpace);
  });

  it('round-trips a file with no trailing newline', () => {
    const noNewline = '{\n    "name": "X",\n    "maps": []\n}';
    expect(serializeInputActions(parseInputActions(noNewline))).toBe(noNewline);
  });

  it('reports a parse error instead of throwing', () => {
    const parsed = parseInputActions('{ not json');
    expect(parsed.error).toBeTruthy();
    expect(parsed.doc).toBeNull();
  });
});

describe('listActions', () => {
  it('flattens maps into qualified actions carrying their bindings', () => {
    const { doc } = parseInputActions(FIXTURE);
    const actions = listActions(doc!);
    expect(actions.map((a) => a.qualifiedName)).toEqual([
      'Player/Move',
      'Player/Interact',
      'Player/Reload',
    ]);
    expect(actions[2].bindings.map((b) => b.path)).toEqual([
      '<Gamepad>/buttonWest',
      '<Keyboard>/r',
    ]);
    expect(actions[0].expectedControlType).toBe('Vector2');
  });
});

describe('findBindingConflicts', () => {
  it('catches two actions in one map claiming the same control', () => {
    const { doc } = parseInputActions(FIXTURE);
    const conflicts = findBindingConflicts(doc!);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0].path).toBe('<Gamepad>/buttonWest');
    expect(conflicts[0].actions).toEqual(['Player/Interact', 'Player/Reload']);
    // Declaration order decides which action actually receives the input.
    expect(conflicts[0].winner).toBe('Player/Interact');
    expect(conflicts[0].starved).toEqual(['Player/Reload']);
  });

  it('does not flag the same path in different maps', () => {
    const { doc } = parseInputActions(FIXTURE);
    doc!.maps.push({
      name: 'UI',
      id: 'u',
      actions: [{ name: 'Submit', type: 'Button', id: 'x', expectedControlType: 'Button' }],
      bindings: [{ id: 'y', path: '<Gamepad>/buttonWest', action: 'Submit' }],
    });
    // Maps are enabled independently, so the same control in two maps is a
    // normal, deliberate pattern rather than a bug.
    expect(findBindingConflicts(doc!)).toHaveLength(1);
  });

  it('ignores composite parents, which hold no control of their own', () => {
    const { doc } = parseInputActions(FIXTURE);
    doc!.maps[0].bindings.push(
      { id: 'c1', path: '2DVector', action: 'Move', isComposite: true },
      { id: 'c2', path: '2DVector', action: 'Interact', isComposite: true },
    );
    expect(findBindingConflicts(doc!)).toHaveLength(1);
  });
});

describe('setBindingPath', () => {
  it('rewrites one path and leaves the rest of the file untouched', () => {
    const parsed = parseInputActions(FIXTURE);
    const next = setBindingPath(parsed, 'b0000000-0000-4000-8000-000000000003', '<Gamepad>/buttonNorth');
    const before = serializeInputActions(parsed).split('\n');
    const after = serializeInputActions(next).split('\n');
    const changed = before.map((l, i) => (l === after[i] ? null : i)).filter((i) => i !== null);
    expect(changed).toHaveLength(1);
    expect(after[changed[0] as number]).toContain('<Gamepad>/buttonNorth');
  });

  it('resolves the conflict it was aimed at', () => {
    const parsed = parseInputActions(FIXTURE);
    const next = setBindingPath(parsed, 'b0000000-0000-4000-8000-000000000003', '<Gamepad>/buttonNorth');
    expect(findBindingConflicts(next.doc!)).toEqual([]);
  });

  it('leaves the document alone when the id is unknown', () => {
    const parsed = parseInputActions(FIXTURE);
    const next = setBindingPath(parsed, 'no-such-id', '<Gamepad>/buttonNorth');
    expect(serializeInputActions(next)).toBe(FIXTURE);
  });
});

describe('qualifiedActionName', () => {
  it('joins map and action the way C# addresses them', () => {
    expect(qualifiedActionName('Player', 'Jump')).toBe('Player/Jump');
  });
});
