// These checks catch the class of Unity bug that produces NO compiler error:
// a mistyped tag, a renamed layer, a scene left out of the build settings, an
// input axis that only exists on one machine. The tests below therefore care
// most about two things — that a wrong literal IS reported, and that a correct
// one is NOT (a false positive here would be noise on every valid file).

import { describe, it, expect, beforeEach } from 'bun:test';
import { scanCSharp } from '../services/csharp-scan';
import { projectSettingsLiteralsRule } from './project-settings-literals';
import {
  __setProjectSettingsForTest,
  type ProjectSettingsSnapshot,
} from '../services/project-settings-cache';

const SNAPSHOT: ProjectSettingsSnapshot = {
  scriptingDefines: {},
  tags: ['Player', 'Enemy'],
  layers: ['Default', 'TransparentFX', 'Ignore Raycast', '', 'Water'],
  scenes: [
    { path: 'Assets/Scenes/Main.unity', enabled: true, guid: 'a'.repeat(32) },
    { path: 'Assets/Scenes/Secret.unity', enabled: false, guid: 'b'.repeat(32) },
  ],
  inputAxes: ['Horizontal', 'Vertical', 'Jump'],
  serializationIsText: true,
};

function run(code: string) {
  // `run` is declared with a `this` reference to the rule, so call it bound.
  return projectSettingsLiteralsRule.run(scanCSharp(code), {
    model: null,
    filePath: '/proj/Assets/T.cs',
    unityVersion: '6000.3.5f2',
    monaco: null,
  });
}

const codes = (fs: ReturnType<typeof run>) => fs.map((f) => f.code);

beforeEach(() => __setProjectSettingsForTest(SNAPSHOT));

describe('with no snapshot loaded', () => {
  it('reports nothing rather than guessing', () => {
    __setProjectSettingsForTest(null);
    expect(run('if (CompareTag("Nope")) { }')).toEqual([]);
  });
});

describe('tags', () => {
  it('flags an undefined tag and suggests a case-differing match', () => {
    const f = run('void A() { if (CompareTag("player")) { } }');
    expect(codes(f)).toEqual(['UNITY0301']);
    expect(f[0].message).toContain("Did you mean 'Player'");
  });

  it('accepts defined tags and the always-valid Untagged', () => {
    expect(run('void A() { CompareTag("Player"); }')).toEqual([]);
    expect(run('void A() { CompareTag("Untagged"); }')).toEqual([]);
  });

  it('covers the comparison forms, not just CompareTag', () => {
    expect(codes(run('void A() { if (tag == "Ghost") { } }'))).toEqual(['UNITY0301']);
    expect(codes(run('void A() { if (other.tag != "Ghost") { } }'))).toEqual(['UNITY0301']);
    expect(codes(run('void A() { GameObject.FindWithTag("Ghost"); }'))).toEqual(['UNITY0301']);
  });

  it('squiggles the literal, not the API call', () => {
    const src = 'void A() { CompareTag("Ghost"); }';
    const f = run(src);
    expect(src.slice(f[0].start, f[0].end)).toBe('"Ghost"');
  });
});

describe('layers', () => {
  it('flags an unknown layer name', () => {
    expect(codes(run('void A() { LayerMask.NameToLayer("Lava"); }'))).toEqual(['UNITY0302']);
  });

  it('accepts a defined layer, including one after a blank slot', () => {
    // Water is layer 4, sitting after an unused slot 3. A parser that filtered
    // blanks would renumber it and this would wrongly pass or fail.
    expect(run('void A() { LayerMask.NameToLayer("Water"); }')).toEqual([]);
    expect(run('void A() { LayerMask.GetMask("Default"); }')).toEqual([]);
  });
});

describe('scenes', () => {
  it('flags a scene that is not in the build settings at all', () => {
    expect(codes(run('void A() { SceneManager.LoadScene("Level9"); }'))).toEqual(['UNITY0303']);
  });

  it('distinguishes a disabled scene from a missing one', () => {
    const f = run('void A() { SceneManager.LoadScene("Secret"); }');
    expect(codes(f)).toEqual(['UNITY0304']);
    expect(f[0].message).toContain('disabled');
  });

  it('accepts both the short name and the full path form', () => {
    expect(run('void A() { SceneManager.LoadScene("Main"); }')).toEqual([]);
    expect(run('void A() { SceneManager.LoadScene("Assets/Scenes/Main.unity"); }')).toEqual([]);
  });
});

describe('input axes', () => {
  it('flags an axis missing from the Input Manager', () => {
    const f = run('void A() { Input.GetAxis("Strafe"); }');
    expect(codes(f)).toEqual(['UNITY0305']);
    expect(f[0].message).toContain('ArgumentException');
  });

  it('accepts defined axes across the Get* family', () => {
    expect(run('void A() { Input.GetAxisRaw("Horizontal"); }')).toEqual([]);
    expect(run('void A() { Input.GetButtonDown("Jump"); }')).toEqual([]);
  });
});

describe('Resources paths', () => {
  it('flags a leading slash and a file extension', () => {
    expect(codes(run('void A() { Resources.Load("/Prefabs/Hero"); }'))).toEqual(['UNITY0306']);
    const f = run('void A() { Resources.Load<GameObject>("Prefabs/Hero.prefab"); }');
    expect(codes(f)).toEqual(['UNITY0306']);
    expect(f[0].message).toContain("'Prefabs/Hero'");
  });

  // Whether an arbitrary path exists needs the asset index, so an unknown but
  // well-formed path must stay silent rather than produce a false positive.
  it('stays silent on a well-formed path it cannot verify', () => {
    expect(run('void A() { Resources.Load("Prefabs/Hero"); }')).toEqual([]);
  });
});
