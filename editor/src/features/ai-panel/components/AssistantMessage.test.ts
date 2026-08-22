import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

// Source-text check (same technique as `EffortSelector.test.ts`): this
// component statically imports `stores/ai.ts` (for the `AiMessage` type,
// erased at runtime — but also transitively through other AssistantMessage
// imports), so it can't be rendered under plain `bun test`. `modelShortName`'s
// stripping logic is fully unit-tested directly in `served-model.test.ts` —
// this file only pins the turn-final CONDITION that gates the footer.
const SRC = readFileSync(path.resolve(import.meta.dir, './AssistantMessage.tsx'), 'utf8');

describe('AssistantMessage — served-model footer', () => {
  it('renders only when the turn is finished, ended in a plain stop, and a model was actually served', () => {
    expect(SRC).toMatch(
      /!message\.isStreaming && message\.stopReason === 'stop' && message\.servedModel/,
    );
  });

  it('renders through modelShortName, never the raw servedModel id', () => {
    expect(SRC).toMatch(/\{modelShortName\(message\.servedModel\)\}/);
  });
});
