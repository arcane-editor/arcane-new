import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Source-text check (same technique as `EffortSelector.test.ts`): this
// component statically imports `stores/ai.ts` (for the `AiMessage` type,
// erased at runtime — but also transitively through other AssistantMessage
// imports), so it can't be rendered under plain `bun test`.
//
// What this pins is a product rule, not a formatting one: the underlying
// model id never reaches the screen. It used to. A "served-model footer"
// printed one under every answer, via a shortener that stripped only the
// literal `@cf/` — so `@cf/zai-org/glm-5.3-flash` rendered as
// `zai-org/glm-5.3-flash`, vendor org and all. That shortener had its own
// green unit tests; they asserted that exact string was correct output.
// Hiding the id is therefore not something to leave to a formatting helper:
// the component must not render the field at all.
const RAW = readFileSync(path.resolve(import.meta.dir, './AssistantMessage.tsx'), 'utf8');

/** Comments explain why the footer is gone and name the very things being
 *  banned, so they have to come out before matching — otherwise this asserts
 *  against prose instead of code. */
const SRC = RAW.replace(/\/\*[\s\S]*?\*\//g, '')
  .split('\n')
  .filter((line) => !/^\s*\/\//.test(line))
  .join('\n');

describe('AssistantMessage — the served model stays off screen', () => {
  it('never renders message.servedModel', () => {
    expect(SRC).not.toMatch(/message\.servedModel/);
  });

  it('carries no served-model footer element', () => {
    expect(SRC).not.toContain('ai-message-served-model');
  });

  it('does not reach for a model-id formatter', () => {
    expect(SRC).not.toContain('modelShortName');
  });
});
