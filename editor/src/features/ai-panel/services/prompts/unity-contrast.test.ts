import { describe, it, expect } from 'bun:test';
import { contrastRows, contrastFactLines, type ContrastFacts } from './unity-contrast';

const NULL_FACTS: ContrastFacts = { renderPipeline: null, inputSystem: null };

describe('contrastRows', () => {
  it('URP + New: shader-property, postfx, and new-input rows apply (not Built-in/legacy ones)', () => {
    const ids = contrastRows({ renderPipeline: 'URP', inputSystem: 'New' }).map((r) => r.id);
    expect(ids).toContain('urp-color');
    expect(ids).toContain('urp-postfx');
    expect(ids).toContain('input-new');
    expect(ids).toContain('deprecated-www');
    expect(ids).toContain('deprecated-loadlevel');
    expect(ids).not.toContain('builtin-color');
    expect(ids).not.toContain('builtin-postfx');
    expect(ids).not.toContain('input-legacy');
    expect(ids).toHaveLength(5);
  });

  it('URP + Legacy (the trap combination): URP rows + legacy-input row both apply', () => {
    const ids = contrastRows({ renderPipeline: 'URP', inputSystem: 'Legacy' }).map((r) => r.id);
    expect(ids.sort()).toEqual(
      ['deprecated-loadlevel', 'deprecated-www', 'input-legacy', 'urp-color', 'urp-postfx'].sort(),
    );
  });

  it('Built-in + Legacy: Built-in rows + legacy-input row apply (not URP/new-input ones)', () => {
    const ids = contrastRows({ renderPipeline: 'Built-in', inputSystem: 'Legacy' }).map((r) => r.id);
    expect(ids.sort()).toEqual(
      ['builtin-color', 'builtin-postfx', 'deprecated-loadlevel', 'deprecated-www', 'input-legacy'].sort(),
    );
  });

  it('input "Both": no input-specific row fires either direction', () => {
    const ids = contrastRows({ renderPipeline: 'Built-in', inputSystem: 'Both' }).map((r) => r.id);
    expect(ids).not.toContain('input-new');
    expect(ids).not.toContain('input-legacy');
    expect(ids.sort()).toEqual(['builtin-color', 'builtin-postfx', 'deprecated-loadlevel', 'deprecated-www'].sort());
  });

  it('null facts: only the version-independent deprecation rows apply', () => {
    const ids = contrastRows(NULL_FACTS).map((r) => r.id);
    expect(ids.sort()).toEqual(['deprecated-loadlevel', 'deprecated-www'].sort());
  });

  it('HDRP: no render-pipeline-specific row applies (table only covers URP/Built-in contrasts)', () => {
    const ids = contrastRows({ renderPipeline: 'HDRP', inputSystem: null }).map((r) => r.id);
    expect(ids.sort()).toEqual(['deprecated-loadlevel', 'deprecated-www'].sort());
  });
});

describe('contrastFactLines', () => {
  it('renders the URP shader-property contrast line verbatim', () => {
    const lines = contrastFactLines({ renderPipeline: 'URP', inputSystem: null });
    expect(lines).toContain(
      '- Shader color property is `_BaseColor` (texture: `_BaseMap`). `_Color`/`_MainTex` are WRONG in this project (Built-in names).',
    );
  });

  it('renders the Built-in shader-property contrast line verbatim (inverse)', () => {
    const lines = contrastFactLines({ renderPipeline: 'Built-in', inputSystem: null });
    expect(lines).toContain(
      '- `_Color`/`_MainTex` are correct here; `_BaseColor`/`_BaseMap` are URP names and WRONG here.',
    );
  });

  it('renders the new-Input-System contrast line verbatim', () => {
    const lines = contrastFactLines({ renderPipeline: null, inputSystem: 'New' });
    expect(lines).toContain(
      '- New Input System is active: `Input.GetAxis/GetKey/GetButton/GetMouseButton` are WRONG here — use InputAction/PlayerInput.',
    );
  });

  it('renders the legacy-Input-Manager contrast line verbatim', () => {
    const lines = contrastFactLines({ renderPipeline: null, inputSystem: 'Legacy' });
    expect(lines).toContain(
      '- Legacy Input Manager is active: do NOT use `UnityEngine.InputSystem`/InputAction (package not enabled) — `Input.GetAxis` etc. are correct here.',
    );
  });

  it('null facts yields exactly the two deprecation lines', () => {
    const lines = contrastFactLines(NULL_FACTS);
    expect(lines).toHaveLength(2);
    expect(lines.some((l) => l.includes('WWW'))).toBe(true);
    expect(lines.some((l) => l.includes('Application.LoadLevel'))).toBe(true);
  });

  it('every line starts with "- " (bullet-ready for direct push into the facts block)', () => {
    const lines = contrastFactLines({ renderPipeline: 'URP', inputSystem: 'New' });
    for (const line of lines) expect(line.startsWith('- ')).toBe(true);
  });
});

describe('wrongTokens regex precision (single source for the P2.2 answer-linter)', () => {
  function patternsFor(id: string, facts: ContrastFacts) {
    const row = contrastRows(facts).find((r) => r.id === id);
    if (!row) throw new Error(`row ${id} did not apply for given facts`);
    return row.wrongTokens.map((t) => new RegExp(t.pattern, t.flags));
  }

  it('urp-color flags "_Color"/"_MainTex" as a quoted shader-property string (SetColor/SetTexture calls and bare quoted tokens — code-block-only scoping is P2.2\'s job, not this table\'s)', () => {
    const patterns = patternsFor('urp-color', { renderPipeline: 'URP', inputSystem: null });
    expect(patterns.some((re) => re.test('material.SetColor("_Color", Color.red);'))).toBe(true);
    expect(patterns.some((re) => re.test('material.SetTexture("_MainTex", tex);'))).toBe(true);
    expect(patterns.some((re) => re.test('"_Color"'))).toBe(true);
  });

  it('builtin-color flags "_BaseColor"/"_BaseMap" string usage (inverse of urp-color)', () => {
    const patterns = patternsFor('builtin-color', { renderPipeline: 'Built-in', inputSystem: null });
    expect(patterns.some((re) => re.test('material.SetColor("_BaseColor", Color.red);'))).toBe(true);
    expect(patterns.some((re) => re.test('material.SetTexture("_BaseMap", tex);'))).toBe(true);
  });

  it('urp-postfx flags an OnRenderImage method definition', () => {
    const patterns = patternsFor('urp-postfx', { renderPipeline: 'URP', inputSystem: null });
    expect(patterns.some((re) => re.test('void OnRenderImage(RenderTexture src, RenderTexture dest)'))).toBe(
      true,
    );
    // Should not misfire on an unrelated method that merely mentions the name in prose.
    expect(patterns.some((re) => re.test('// OnRenderImage is not used here'))).toBe(false);
  });

  it('builtin-postfx flags a ScriptableRenderPass base-class usage', () => {
    const patterns = patternsFor('builtin-postfx', { renderPipeline: 'Built-in', inputSystem: null });
    expect(patterns.some((re) => re.test('class BlurPass : ScriptableRenderPass'))).toBe(true);
  });

  it('input-new flags legacy Input.* calls', () => {
    const patterns = patternsFor('input-new', { renderPipeline: null, inputSystem: 'New' });
    expect(patterns.some((re) => re.test('Input.GetAxis("Horizontal")'))).toBe(true);
    expect(patterns.some((re) => re.test('Input.GetKeyDown(KeyCode.Space)'))).toBe(true);
  });

  it('input-legacy flags new Input System usage', () => {
    const patterns = patternsFor('input-legacy', { renderPipeline: null, inputSystem: 'Legacy' });
    expect(patterns.some((re) => re.test('using UnityEngine.InputSystem;'))).toBe(true);
    expect(patterns.some((re) => re.test('public InputAction moveAction;'))).toBe(true);
    expect(patterns.some((re) => re.test('PlayerInput playerInput;'))).toBe(true);
  });

  it('deprecated-www flags `new WWW(...)`', () => {
    const patterns = patternsFor('deprecated-www', NULL_FACTS);
    expect(patterns.some((re) => re.test('var www = new WWW(url);'))).toBe(true);
  });

  it('deprecated-loadlevel flags `Application.LoadLevel(...)`', () => {
    const patterns = patternsFor('deprecated-loadlevel', NULL_FACTS);
    expect(patterns.some((re) => re.test('Application.LoadLevel("Main");'))).toBe(true);
  });
});
