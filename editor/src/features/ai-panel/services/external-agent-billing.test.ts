import { describe, it, expect } from 'bun:test';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * External agents run on the user's OWN provider account. A Claude turn is
 * billed by Anthropic, never by Arcane — it must not move the credit ledger,
 * must not hit Arcane's metered `/v1/chat/completions`, and must not accumulate
 * into `sessionUsage`.
 *
 * That invariant is enforced statically rather than at runtime, for the same
 * reason `file-uri-single-source.test.ts` is: a mocked-store test proves one
 * code path did not bill, while a source scan proves no code path CAN. The
 * failure this guards against is a future refactor that "unifies" the two
 * backends by routing the external one through `arcane-stream.ts`.
 */

const HERE = path.dirname(new URL(import.meta.url).pathname);
const SRC = path.resolve(HERE, '../../..');

/** Every file that runs as part of an external-agent turn. */
const EXTERNAL_AGENT_SOURCES = [
  path.join(SRC, 'features/acp'),
  path.join(SRC, 'features/ai-panel/services/claude-backend.ts'),
  path.join(SRC, 'features/ai-panel/services/chat-backend.ts'),
  path.join(SRC, 'features/ai-panel/services/acp-fs.ts'),
  path.join(SRC, 'features/ai-panel/services/acp-terminals.ts'),
  path.join(SRC, 'features/ai-panel/services/acp-translate.ts'),
  path.join(SRC, 'features/ai-panel/services/mcp-config.ts'),
];

/** Symbols that mean "Arcane is paying for this". */
const BILLING_MARKERS = [
  'recordSessionUsage',
  'arcane-stream',
  '/v1/chat/completions',
  'ARCANE_SERVER_URL',
  'checkAiBudget',
];

/**
 * Strip comments before scanning. The invariant is about what the code DOES —
 * a doc comment that names `arcane-stream.ts` as a precedent is not a billing
 * path, and failing on prose would just train people to delete the prose.
 */
function code(file: string): string {
  return readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function collect(target: string): string[] {
  const stat = statSync(target);
  if (stat.isFile()) return target.endsWith('.ts') || target.endsWith('.tsx') ? [target] : [];
  return readdirSync(target).flatMap((entry) => collect(path.join(target, entry)));
}

describe('external agents never bill Arcane credits', () => {
  const files = EXTERNAL_AGENT_SOURCES.flatMap(collect).filter((f) => !f.endsWith('.test.ts'));

  it('scans a non-empty set of files (guards against the paths going stale)', () => {
    expect(files.length).toBeGreaterThanOrEqual(7);
  });

  for (const marker of BILLING_MARKERS) {
    it(`no external-agent source references ${marker}`, () => {
      const offenders = files.filter((f) => code(f).includes(marker));
      expect(offenders.map((f) => path.relative(SRC, f))).toEqual([]);
    });
  }

  it('only the Arcane stream records session usage', () => {
    const all = collect(SRC).filter((f) => !f.endsWith('.test.ts'));
    const callers = all.filter((f) => /recordSessionUsage\s*\(/.test(code(f)));
    expect(callers.map((f) => path.relative(SRC, f)).sort()).toEqual([
      'features/ai-panel/services/arcane-stream.ts',
    ]);
  });
});
