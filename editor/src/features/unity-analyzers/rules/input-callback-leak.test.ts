// The leak is invisible: it compiles, it runs, and the only symptom is a
// callback that fires twice after the second scene load. So the tests care
// about the asymmetry (subscribed but not released) and about NOT firing on
// the correct, symmetric shape that most well-written scripts already use.

import { describe, it, expect } from 'bun:test';
import { scanCSharp } from '../services/csharp-scan';
import { inputCallbackLeakRule } from './input-callback-leak';

function run(code: string) {
  return inputCallbackLeakRule.run(scanCSharp(code), {
    model: null,
    filePath: '/proj/Assets/T.cs',
    unityVersion: '6000.3.5f2',
    monaco: null,
  });
}

describe('inputCallbackLeakRule', () => {
  it('reports a subscription with no matching unsubscribe', () => {
    const found = run(`
      class C {
        void OnEnable() { jump.performed += OnJump; }
        void OnDisable() { }
      }
    `);
    expect(found.map((f) => f.code)).toEqual(['UNITY0404']);
    expect(found[0].message).toContain('OnJump');
    expect(found[0].message).toContain('jump.performed -= OnJump;');
  });

  it('accepts a symmetric subscribe/unsubscribe pair', () => {
    expect(
      run(`
      class C {
        void OnEnable() { jump.performed += OnJump; }
        void OnDisable() { jump.performed -= OnJump; }
      }
    `),
    ).toEqual([]);
  });

  it('reports every unreleased handler, not just the first', () => {
    const found = run(`
      class C {
        void OnEnable() {
          jump.performed += OnJump;
          fire.started += OnFire;
          look.canceled += OnLook;
        }
        void OnDisable() { jump.performed -= OnJump; }
      }
    `);
    expect(found).toHaveLength(2);
    expect(found.map((f) => f.message).join(' ')).toContain('OnFire');
    expect(found.map((f) => f.message).join(' ')).toContain('OnLook');
  });

  it('treats a missing OnDisable as the worst case, not an exemption', () => {
    const found = run('class C { void OnEnable() { jump.performed += OnJump; } }');
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain('does not declare');
  });

  it('says nothing when OnEnable subscribes to nothing', () => {
    expect(run('class C { void OnEnable() { controls.Enable(); } }')).toEqual([]);
  });

  it('ignores ordinary C# events, which have their own lifetime rules', () => {
    expect(run('class C { void OnEnable() { health.Changed += OnChanged; } }')).toEqual([]);
  });

  it('says nothing in a class with no OnEnable at all', () => {
    expect(run('class C { void Update() { jump.performed += OnJump; } }')).toEqual([]);
  });

  it('ignores a subscription that only appears in a comment', () => {
    expect(
      run(`
      class C {
        void OnEnable() { /* jump.performed += OnJump; */ }
        void OnDisable() { }
      }
    `),
    ).toEqual([]);
  });
});
