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
