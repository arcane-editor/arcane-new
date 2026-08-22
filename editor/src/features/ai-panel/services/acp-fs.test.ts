import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';

// Source-level assertions, matching `AssistantMessage.test.ts`: this module's
// behaviour is Tauri `invoke` plus three Zustand stores, none of which exist in
// a bun test, and the properties worth guarding are structural.
const SRC = readFileSync(new URL('./acp-fs.ts', import.meta.url), 'utf8');

/**
 * Code only. The doc comments deliberately NAME what was removed and why, so an
 * assertion over the raw file would match the explanation rather than the
 * behaviour — and would force the next person to delete the reasoning in order
 * to keep the test green.
 */
const CODE = SRC.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

describe('acp-fs — reads are unconfined, writes are not', () => {
  /**
   * The sandbox narrowed a Unity project to `Assets/`, putting
   * `ProjectSettings/`, the repo root and `*.csproj` out of reach of the
   * agent's Read tool — while `acp-terminals.ts` handed the same agent an
   * unconfined shell. It caged the legible path and left the illegible one
   * open.
   */
  it('resolves a read with no root list', () => {
    expect(CODE).toMatch(/function resolveForRead[\s\S]*?resolveWithinRoot\(path, workspacePath\(\), null\)/);
    expect(CODE).toMatch(/const path = resolveForRead\(params\.path\)/);
  });

  it('still confines a write, to the workspace', () => {
    expect(CODE).toMatch(/function resolveForWrite[\s\S]*?resolveWithinRoot\(path, workspacePath\(\), writeRoots\(\)\)/);
    expect(CODE).toMatch(/const path = resolveForWrite\(params\.path\)/);
    expect(CODE).toContain('computeExternalAgentWriteRoots');
  });

  it('no longer applies the Arcane agent\'s own tool sandbox', () => {
    expect(CODE).not.toContain('computeAllowedRoots');
  });
});

describe('acp-fs — undo survives, the review queue does not', () => {
  /**
   * The trade this module encodes: checkpoints record BYTES and are what
   * "restore this turn" is built on, so they stay. The Accept/Reject queue is a
   * WORKFLOW built around the Arcane agent's `auto` apply mode, so it goes.
   */
  it('keeps the pre-write checkpoint', () => {
    expect(CODE).toContain('recordPreWrite');
  });

  it('does not enrol the write in the edit-review queue', () => {
    expect(CODE).not.toContain('useEditReviewStore');
    expect(CODE).not.toContain('.register(');
  });

  it('still reads the previous content BEFORE writing', () => {
    // Once the write lands, the bytes captured here are the only copy of what
    // it replaced — without them the checkpoint cannot restore.
    expect(CODE.indexOf("read_file', { path }).catch")).toBeLessThan(CODE.indexOf("invoke('write_file'"));
  });
});
