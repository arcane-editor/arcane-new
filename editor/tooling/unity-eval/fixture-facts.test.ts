import { describe, it, expect } from 'bun:test';
import { buildFixtureFacts, buildFixtureGroundingContext } from './fixture-facts';

const FIXTURES = new URL('./fixtures/', import.meta.url).pathname;

describe('buildFixtureFacts', () => {
  it('detects Built-in + legacy input', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'builtin-legacy');
    expect(facts).toContain('Unity version: 2022.3.45f1');
    expect(facts).toContain('Render pipeline: Built-in');
    expect(facts).toContain('Input system: Input Manager (legacy)');
  });

  it('detects URP + new Input System', async () => {
    const facts = await buildFixtureFacts(FIXTURES + 'urp-newinput');
    expect(facts).toContain('Unity version: 6000.0.23f1');
    expect(facts).toContain('Render pipeline: URP');
    expect(facts).toContain('Input system: Input System (new)');
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
      unityVersion: '6000.0.23f1',
      renderPipeline: 'URP',
      inputSystem: 'New',
    });
  });
});
