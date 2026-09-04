import { describe, it, expect } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildFixtureFacts, buildFixtureGroundingContext } from './fixture-facts';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

describe('buildFixtureFacts', () => {
  // Regression: builtin-legacy and urp-newinput ship no ProjectSettings.asset,
  // so they must keep going through the package-presence fallback path
  // byte-unchanged after the activeInputHandler support was added below.
  it('detects Built-in + legacy input', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'builtin-legacy');
    expect(facts).toContain('Unity version: 2022.3.45f1');
    expect(facts).toContain('Render pipeline: Built-in');
    expect(facts).toContain('Input system: Input Manager (legacy)');
  });

  it('detects URP + new Input System', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'urp-newinput');
    expect(facts).toContain('Unity version: 6000.3.5f2');
    expect(facts).toContain('Render pipeline: URP');
    expect(facts).toContain('Input system: Input System (new)');
  });

  // The trap fixture: URP + no `com.unity.inputsystem` package, but
  // `ProjectSettings.asset`'s `activeInputHandler: 0` is authoritative —
  // package-presence inference alone would get this wrong (indistinguishable
  // from `builtin-legacy`), and a model's training-default assumption that
  // "URP" implies "new Input System" would also get it wrong.
  it('detects URP + legacy input for the urp2022-legacyinput trap fixture', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'urp2022-legacyinput');
    expect(facts).toContain('Unity version: 2022.3.45f1');
    expect(facts).toContain('Render pipeline: URP');
    expect(facts).toContain('Input system: Input Manager (legacy)');
  });
});

describe('buildFixtureGroundingContext', () => {
  it('derives structured grounding context for Built-in + legacy input', async () => {
    const ctx = await buildFixtureGroundingContext(FIXTURES + 'builtin-legacy');
    expect(ctx).toEqual({
      unityVersion: '2022.3.45f1',
      renderPipeline: 'Built-in',
      inputSystem: 'Legacy',
    });
  });

  it('derives structured grounding context for URP + new Input System', async () => {
    const ctx = await buildFixtureGroundingContext(FIXTURES + 'urp-newinput');
    expect(ctx).toEqual({
      unityVersion: '6000.3.5f2',
      renderPipeline: 'URP',
      inputSystem: 'New',
    });
  });

  it('derives structured grounding context for the urp2022-legacyinput trap fixture', async () => {
    const ctx = await buildFixtureGroundingContext(FIXTURES + 'urp2022-legacyinput');
    expect(ctx).toEqual({
      unityVersion: '2022.3.45f1',
      renderPipeline: 'URP',
      inputSystem: 'Legacy',
    });
  });
});

describe('activeInputHandler parsing (ProjectSettings.asset authoritative over package presence)', () => {
  async function writeMinimalFixture(dir: string, activeInputHandler: number): Promise<void> {
    await mkdir(join(dir, 'ProjectSettings'), { recursive: true });
    await mkdir(join(dir, 'Packages'), { recursive: true });
    await writeFile(
      join(dir, 'ProjectSettings', 'ProjectVersion.txt'),
      'm_EditorVersion: 2022.3.45f1\n',
    );
    await writeFile(
      join(dir, 'ProjectSettings', 'ProjectSettings.asset'),
      [
        '%YAML 1.1',
        '%TAG !u! tag:unity3d.com,2011:',
        '--- !u!129 &1',
        'PlayerSettings:',
        '  serializedVersion: 26',
        `  activeInputHandler: ${activeInputHandler}`,
        '',
      ].join('\n'),
    );
    // No com.unity.inputsystem dependency — proves the asset value wins
    // over the (absent) package, not just over a present one.
    await writeFile(
      join(dir, 'Packages', 'manifest.json'),
      JSON.stringify({ dependencies: {} }),
    );
  }

  it('activeInputHandler: 1 reports the new Input System', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-input-handler-'));
    try {
      await writeMinimalFixture(dir, 1);
      const facts = await buildFixtureFacts(dir);
      expect(facts).toContain('Input system: Input System (new)');
      const ctx = await buildFixtureGroundingContext(dir);
      expect(ctx.inputSystem).toBe('New');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('activeInputHandler: 2 reports both input systems', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-input-handler-'));
    try {
      await writeMinimalFixture(dir, 2);
      const facts = await buildFixtureFacts(dir);
      expect(facts).toContain('Input system: Both (Input Manager + Input System)');
      const ctx = await buildFixtureGroundingContext(dir);
      expect(ctx.inputSystem).toBe('Both');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// Task 16 (B9): `uiDesignFactLines` is correctly absent from every eval fixture
// prompt, for the same reason the ScriptableObject/UI Toolkit/Input DETAIL
// blocks are (see the comment in `buildFixtureFacts` next to `inventory`) —
// production only appends it when `selectSubsystems` picks `uiToolkit`, which
// requires an active file the headless eval never has. This fixture ships a
// `.uxml`, a `.uss` with a `--color-bg` custom property, and a `.asset` that
// serializes a `PanelSettings` — exactly the inputs that would make production
// render "USS variables"/"Panel:" lines — to prove the absence is deliberate,
// not an oversight that happens not to be exercised by the other fixtures.
describe('buildFixtureFacts — uiDesign facts stay absent even when the project has UI Toolkit content (Task 16 parity)', () => {
  it('never mentions USS variables or a Panel:, even with a themed .uss and a PanelSettings asset', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-ui-design-'));
    try {
      await mkdir(join(dir, 'ProjectSettings'), { recursive: true });
      await mkdir(join(dir, 'Packages'), { recursive: true });
      await mkdir(join(dir, 'Assets', 'UI'), { recursive: true });
      await writeFile(
        join(dir, 'ProjectSettings', 'ProjectVersion.txt'),
        'm_EditorVersion: 6000.3.5f2\n',
      );
      await writeFile(join(dir, 'Packages', 'manifest.json'), JSON.stringify({ dependencies: {} }));
      await writeFile(
        join(dir, 'Assets', 'UI', 'Hud.uxml'),
        '<UXML><VisualElement name="root" /></UXML>',
      );
      await writeFile(
        join(dir, 'Assets', 'UI', 'Theme.uss'),
        ':root { --color-bg: #1b1726; }',
      );
      await writeFile(
        join(dir, 'Assets', 'UI', 'GamePanel.asset'),
        'MonoBehaviour:\n  m_Script: {...}\n  ...UnityEngine.UIElements.PanelSettings...\n  m_Name: GamePanel\n',
      );

      const facts = await buildFixtureFacts(dir);
      expect(facts).toContain('UI Toolkit (1 .uxml, 1 .uss)');
      expect(facts).not.toContain('USS variables');
      expect(facts).not.toContain('Panel:');
      expect(facts).not.toContain('--color-bg');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// P2.1: contrastive anti-default facts (`unity-contrast.ts`) are appended as
// ADDITIONS at the end of `buildFixtureFacts`'s output, derived from the same
// pipeline/inputSystem values detected above. Full-string assertions here
// double as a regression check that the pre-existing base lines (header,
// version, render pipeline, input system) stay byte-identical — a wording
// change to those four lines would fail these tests just as loudly as a
// wrong/missing contrast line would.
describe('contrast facts integration (P2.1)', () => {
  it('builtin-legacy (Built-in + legacy): builtin-color, builtin-postfx, input-legacy, + both deprecations', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'builtin-legacy');
    expect(facts).toBe(
      [
        '## Unity project facts (authoritative — match these)',
        '- Unity version: 2022.3.45f1',
        '- Render pipeline: Built-in',
        '- Input system: Input Manager (legacy)',
        '- `_Color`/`_MainTex` are correct here; `_BaseColor`/`_BaseMap` are URP names and WRONG here.',
        '- Full-screen effects: `OnRenderImage` is the classic approach here; `ScriptableRenderPass` is URP-only and does not apply to this project.',
        '- Legacy Input Manager is active: do NOT use `UnityEngine.InputSystem`/InputAction (package not enabled) — `Input.GetAxis` etc. are correct here.',
        '- `WWW` is deprecated — use `UnityWebRequest` for networking/file loads instead.',
        '- `Application.LoadLevel` is deprecated — use `SceneManager.LoadScene` instead.',
      ].join('\n'),
    );
  });

  // Task 18 (B11): `urp-newinput` now ships a seeded HUD (Assets/UI/HUD.uxml
  // + Theme.uss, for the `codegen-ui-hud` eval task — see `tasks.ts`), so this
  // golden string gained the subsystem-inventory line every other fixture
  // with real UI Toolkit files already gets.
  it('urp-newinput (URP + new): urp-color, urp-postfx, input-new, + both deprecations', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'urp-newinput');
    expect(facts).toBe(
      [
        '## Unity project facts (authoritative — match these)',
        '- Unity version: 6000.3.5f2',
        '- Render pipeline: URP',
        '- Input system: Input System (new)',
        '- Unity subsystems in use: UI Toolkit (1 .uxml, 1 .uss)',
        '- Shader color property is `_BaseColor` (texture: `_BaseMap`). `_Color`/`_MainTex` are WRONG in this project (Built-in names).',
        '- Full-screen effects: `OnRenderImage` does NOT run under URP — use a ScriptableRenderPass / Renderer Feature.',
        '- New Input System is active: `Input.GetAxis/GetKey/GetButton/GetMouseButton` are WRONG here — use InputAction/PlayerInput.',
        '- `WWW` is deprecated — use `UnityWebRequest` for networking/file loads instead.',
        '- `Application.LoadLevel` is deprecated — use `SceneManager.LoadScene` instead.',
      ].join('\n'),
    );
  });

  it('urp2022-legacyinput (URP + legacy trap fixture): urp-color, urp-postfx, input-legacy, + both deprecations', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'urp2022-legacyinput');
    expect(facts).toBe(
      [
        '## Unity project facts (authoritative — match these)',
        '- Unity version: 2022.3.45f1',
        '- Render pipeline: URP',
        '- Input system: Input Manager (legacy)',
        '- Shader color property is `_BaseColor` (texture: `_BaseMap`). `_Color`/`_MainTex` are WRONG in this project (Built-in names).',
        '- Full-screen effects: `OnRenderImage` does NOT run under URP — use a ScriptableRenderPass / Renderer Feature.',
        '- Legacy Input Manager is active: do NOT use `UnityEngine.InputSystem`/InputAction (package not enabled) — `Input.GetAxis` etc. are correct here.',
        '- `WWW` is deprecated — use `UnityWebRequest` for networking/file loads instead.',
        '- `Application.LoadLevel` is deprecated — use `SceneManager.LoadScene` instead.',
      ].join('\n'),
    );
  });
});
