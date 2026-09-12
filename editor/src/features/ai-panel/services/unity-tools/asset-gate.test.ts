// `asset-gate.ts` cannot be imported under Bun — it reaches `tool-operations.ts`
// → the workspace store → the theme store → `document` — so the wiring is
// asserted against its source text, the same convention `analyzer-gate.test.ts`
// uses and for the same reason. The behaviour it delegates to is unit-tested
// directly in `asset-checks.test.ts`.

import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const SRC = readFileSync(path.resolve(import.meta.dir, './asset-gate.ts'), 'utf8');
const COMPACTION = readFileSync(
  path.resolve(import.meta.dir, '../vendor/compaction.ts'),
  'utf8',
);
const AGENT_SERVICE = readFileSync(
  path.resolve(import.meta.dir, '../agent-service.ts'),
  'utf8',
);

describe('withUnityAssetGate wiring', () => {
  it('returns early unless the write actually landed', () => {
    // Both guards, not one. `isRejectedWrite` alone let every OTHER failed
    // write through, and the gate then checked content that never reached
    // disk — the bug `write-approval-gate.ts`'s header documents.
    expect(SRC).toContain('if (isRejectedWrite(res)) return res;');
    expect(SRC).toContain('if (!isSuccessfulWrite(res)) return res;');
  });

  it('uses the shared predicates rather than a private copy that can drift', () => {
    expect(SRC).toContain(
      "import { isRejectedWrite, isSuccessfulWrite } from '../write-approval-gate';",
    );
  });

  it('checks only the extensions the analyzers do not cover', () => {
    expect(SRC).toContain('isCheckableAsset(p)');
  });

  it('re-reads from disk for an edit, which carries no content', () => {
    expect(SRC).toContain("(params as { content?: string }).content ??");
    expect(SRC).toContain('tauriReadOperations.readFile');
  });

  it('never lets a throwing check take the write down with it', () => {
    expect(SRC).toContain('// A gate that throws must not take the write down with it.');
    expect(SRC).toMatch(/catch \{\s*\n\s*\/\/ A gate that throws[\s\S]*?return res;/);
  });

  it('leaves the result untouched when there is nothing to report and the path is not a UI asset', () => {
    expect(SRC).toContain('if (findings.length === 0 && !tip) return res;');
  });
});

describe('the raw-write nudge toward unity_ui_write', () => {
  it('appends the tip for .uxml/.uss, even on a clean write with no findings', () => {
    expect(SRC).toContain(
      "? '\\n\\nTip: unity_ui_write also creates the .meta and validates before writing.'",
    );
    expect(SRC).toContain(
      "const isUiAsset = lowerP.endsWith('.uxml') || lowerP.endsWith('.uss');",
    );
  });

  it('never appends the tip for .inputactions/.asset', () => {
    // `isUiAsset` is the only source of `tip`, and it names exactly the two
    // UI Toolkit extensions — a raw write/edit gets no unity_ui_write nudge
    // for a format that tool doesn't write.
    expect(SRC).not.toMatch(/isUiAsset[\s\S]{0,80}inputactions/);
  });
});

describe('the gate’s repair note survives compaction', () => {
  it('every label the gate can emit is a compaction repair sentinel', () => {
    // A repair instruction elided under compaction is a repair that never
    // happens — and unlike a compile error, nothing else in Unity will raise
    // these again.
    for (const label of ['[Unity UXML]', '[Unity USS]', '[Unity input actions]', '[Unity asset]']) {
      expect(COMPACTION).toContain(`'${label}'`);
    }
  });
});

describe('the gate is wired into the write stack', () => {
  it('composes with the cs-gates rather than replacing any of them', () => {
    expect(AGENT_SERVICE).toContain('assetGateOn ? withUnityAssetGate(t, workspacePath) : t');
    expect(AGENT_SERVICE).toContain('if (analyzersOn) g = withUnityAnalyzerGate(g, workspacePath);');
    expect(AGENT_SERVICE).toContain('if (lspGateOn) g = withLspDiagnosticsGate(g, workspacePath);');
    expect(AGENT_SERVICE).toContain('if (compileGateOn) g = withUnityCompileGate(g, workspacePath);');
  });

  it('is gated on its own setting, defaulting on', () => {
    expect(AGENT_SERVICE).toContain(
      "settings.getSetting('unity.assetGate.enabled') !== false",
    );
  });
});
