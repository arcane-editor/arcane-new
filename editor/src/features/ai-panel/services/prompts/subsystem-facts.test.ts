// The facts block is frozen per conversation and therefore re-sent on every
// turn of it, so what goes in is a budget decision as much as a correctness
// one. These tests pin both halves of that bargain: the inventory line is
// always cheap and always present, and the expensive detail is spent only on
// the subsystem the conversation is actually about.

import { describe, it, expect } from 'bun:test';
import {
  selectSubsystems,
  presenceOf,
  subsystemInventoryLine,
  scriptableObjectFactLines,
  uiToolkitFactLines,
  SUBSYSTEM_NAME_BUDGET,
  type SubsystemInventory,
} from './subsystem-facts';

const ALL_PRESENT = { scriptableObjects: true, uiToolkit: true, input: true };

describe('selectSubsystems — by extension', () => {
  it('picks the subsystem a Unity asset unambiguously belongs to', () => {
    const cases: Array<[string, string]> = [
      ['/p/Assets/UI/HUD.uxml', 'uiToolkit'],
      ['/p/Assets/UI/Theme.uss', 'uiToolkit'],
      ['/p/Assets/Data/Sword.asset', 'scriptableObjects'],
      ['/p/Assets/Controls.inputactions', 'input'],
    ];
    for (const [path, expected] of cases) {
      expect(
        selectSubsystems({ activeFilePath: path, activeFileText: null, present: ALL_PRESENT }),
      ).toEqual([expected as never]);
    }
  });

  it('is case-insensitive about the extension', () => {
    expect(
      selectSubsystems({ activeFilePath: '/p/HUD.UXML', activeFileText: null, present: ALL_PRESENT }),
    ).toEqual(['uiToolkit']);
  });

  it('never selects a subsystem the project does not use', () => {
    expect(
      selectSubsystems({
        activeFilePath: '/p/Assets/UI/HUD.uxml',
        activeFileText: null,
        present: { ...ALL_PRESENT, uiToolkit: false },
      }),
    ).toEqual([]);
  });
});

describe('selectSubsystems — C# by content', () => {
  const cs = (text: string) =>
    selectSubsystems({ activeFilePath: '/p/Assets/Foo.cs', activeFileText: text, present: ALL_PRESENT });

  it('recognises a ScriptableObject subclass', () => {
    expect(cs('public class WeaponData : ScriptableObject { }')).toEqual(['scriptableObjects']);
  });

  it('recognises a UI Toolkit document driver', () => {
    expect(cs('var b = root.Q<Button>("play");')).toEqual(['uiToolkit']);
  });

  it('recognises Input System usage', () => {
    expect(cs('using UnityEngine.InputSystem;')).toEqual(['input']);
  });

  it('selects every subsystem a single file touches, rather than picking one', () => {
    const text = `
      using UnityEngine.InputSystem;
      public class Hud : MonoBehaviour {
        [SerializeField] private UIDocument doc;
        void Start() { doc.rootVisualElement.Q<Label>("hp"); }
      }`;
    expect(cs(text).sort()).toEqual(['input', 'uiToolkit']);
  });

  it('selects nothing for ordinary gameplay code', () => {
    expect(cs('public class Mover : MonoBehaviour { void Update() { } }')).toEqual([]);
  });

  it('selects nothing when the buffer is not loaded — extension alone says nothing about a .cs', () => {
    expect(
      selectSubsystems({ activeFilePath: '/p/Assets/Foo.cs', activeFileText: null, present: ALL_PRESENT }),
    ).toEqual([]);
  });

  it('selects nothing when no file is open', () => {
    expect(
      selectSubsystems({ activeFilePath: null, activeFileText: 'anything', present: ALL_PRESENT }),
    ).toEqual([]);
  });
});

describe('subsystemInventoryLine', () => {
  const full: SubsystemInventory = {
    scriptableObjects: { types: 12, assets: 87 },
    uiToolkit: { documents: 4, stylesheets: 3 },
    input: { assets: 1, maps: 2 },
  };

  it('names every subsystem with its counts, on one line', () => {
    const line = subsystemInventoryLine(full);
    expect(line).toBe(
      '- Unity subsystems in use: ScriptableObjects (12 types, 87 assets) · UI Toolkit (4 .uxml, 3 .uss) · Input System (1 .inputactions, 2 maps)',
    );
    expect(line?.split('\n')).toHaveLength(1);
  });

  it('omits a subsystem the project does not use rather than saying "0"', () => {
    const line = subsystemInventoryLine({ ...full, uiToolkit: null });
    expect(line).not.toContain('UI Toolkit');
    expect(line).toContain('ScriptableObjects');
  });

  it('returns null when the project uses none of the three', () => {
    expect(
      subsystemInventoryLine({ scriptableObjects: null, uiToolkit: null, input: null }),
    ).toBeNull();
  });

  it('treats a zero count as absent — a type list of length 0 is not a subsystem in use', () => {
    expect(
      subsystemInventoryLine({ scriptableObjects: { types: 0, assets: 0 }, uiToolkit: null, input: null }),
    ).toBeNull();
  });

  it('presenceOf agrees with what the line reports', () => {
    expect(presenceOf(full)).toEqual(ALL_PRESENT);
    expect(presenceOf({ ...full, input: { assets: 0, maps: 0 } }).input).toBe(false);
  });
});

describe('detail blocks', () => {
  it('names the ScriptableObject types and states the failure that costs data', () => {
    const lines = scriptableObjectFactLines({ typeNames: ['WeaponData', 'EnemyStats'] });
    expect(lines.join('\n')).toContain('WeaponData, EnemyStats');
    expect(lines.join('\n')).toContain('FormerlySerializedAs');
    expect(lines.join('\n')).toContain('no compiler error');
  });

  it('names the UXML documents and the element names Q<T>() resolves against', () => {
    const lines = uiToolkitFactLines({
      documents: ['Assets/UI/HUD.uxml'],
      elementNames: ['hp-bar', 'play-button'],
    });
    expect(lines.join('\n')).toContain('Assets/UI/HUD.uxml');
    expect(lines.join('\n')).toContain('hp-bar, play-button');
    expect(lines.join('\n')).toContain('returns null');
  });

  it('says so explicitly when no element is reachable by name, rather than listing nothing', () => {
    const lines = uiToolkitFactLines({ documents: ['Assets/UI/HUD.uxml'], elementNames: [] });
    expect(lines.join('\n')).toContain('has a `name`');
  });

  it('emits nothing at all when the subsystem is empty', () => {
    expect(scriptableObjectFactLines({ typeNames: [] })).toEqual([]);
    expect(uiToolkitFactLines({ documents: [], elementNames: [] })).toEqual([]);
  });

  it('budgets the name list instead of pasting a whole large project into every turn', () => {
    const many = Array.from({ length: 400 }, (_, i) => `VeryLongTypeName${i}`);
    const text = scriptableObjectFactLines({ typeNames: many }).join('\n');
    expect(text).toContain('more');
    // The budget bounds the NAMES; the surrounding prose is fixed and small.
    const names = text.split(': ')[1]?.split('\n')[0] ?? '';
    expect(names.length).toBeLessThan(SUBSYSTEM_NAME_BUDGET + 40);
  });
});
