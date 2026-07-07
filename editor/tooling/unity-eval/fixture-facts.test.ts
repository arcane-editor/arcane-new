import { describe, it, expect } from 'bun:test';
import { buildFixtureFacts } from './fixture-facts';

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
