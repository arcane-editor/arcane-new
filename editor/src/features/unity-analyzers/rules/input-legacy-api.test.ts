// `Input.GetAxis` under activeInputHandler:1 is a guaranteed runtime throw that
// the compiler cannot see -- and the most common way tutorial or AI-generated
// code breaks a modern Unity project. The gating matters as much as the
// detection: firing this on a `Both` project would be wrong on every line.

import { describe, it, expect } from 'bun:test';
import { scanCSharp } from '../services/csharp-scan';
import { inputLegacyApiRule } from './input-legacy-api';
import {
  buildInputActionsIndex,
  __setInputActionsIndexForTest,
} from '../services/inputactions-cache';
import type { InputSystemMode } from '../../../utils/input-system';

function withMode(mode: InputSystemMode) {
  __setInputActionsIndexForTest(buildInputActionsIndex([], mode));
}

function run(code: string) {
  return inputLegacyApiRule.run(scanCSharp(code), {
    model: null,
    filePath: '/proj/Assets/T.cs',
    unityVersion: '6000.3.5f2',
    monaco: null,
  });
}

describe('gating', () => {
  it('stays silent with no snapshot loaded', () => {
    __setInputActionsIndexForTest(null);
    expect(run('var h = Input.GetAxis("Horizontal");')).toEqual([]);
  });

  it('stays silent on a Legacy project, where the call is correct', () => {
    withMode('Legacy');
    expect(run('var h = Input.GetAxis("Horizontal");')).toEqual([]);
  });

  it('stays silent on a Both project, where the legacy class still works', () => {
    withMode('Both');
    expect(run('var h = Input.GetAxis("Horizontal");')).toEqual([]);
  });
});

describe('on a New Input System project', () => {
  it('reports GetAxis and points at the replacement', () => {
    withMode('New');
    const found = run('var h = Input.GetAxis("Horizontal");');
    expect(found.map((f) => f.code)).toEqual(['UNITY0405']);
    expect(found[0].severity).toBe('error');
    expect(found[0].message).toContain('throws at runtime');
    expect(found[0].message).toContain('ReadValue');
  });

  it('reports key, mouse and property forms too', () => {
    withMode('New');
    const found = run(`
      if (Input.GetKeyDown(KeyCode.Space)) { }
      var p = Input.mousePosition;
      var c = Input.touchCount;
    `);
    expect(found).toHaveLength(3);
    expect(found.map((f) => f.message).join(' ')).toContain('wasPressedThisFrame');
    expect(found.map((f) => f.message).join(' ')).toContain('Mouse.current.position');
  });

  it('does not fire on an unrelated identifier ending in Input', () => {
    withMode('New');
    expect(run('var v = playerInput.GetAxis("Horizontal");')).toEqual([]);
  });

  it('ignores a mention inside a comment or string', () => {
    withMode('New');
    expect(run('// Input.GetAxis is banned here\nvar s = "Input.GetAxis";')).toEqual([]);
  });

  it('points the squiggle at the member expression', () => {
    withMode('New');
    const src = 'var h = Input.GetAxis("Horizontal");';
    const found = run(src);
    expect(src.slice(found[0].start, found[0].end)).toBe('Input.GetAxis');
  });
});
