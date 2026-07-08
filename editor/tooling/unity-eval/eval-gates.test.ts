import { describe, it, expect } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createWriteTool } from '../../src/features/ai-panel/services/vendor/tools/write';
import { createEditTool } from '../../src/features/ai-panel/services/vendor/tools/edit';
import { localWriteOperations, localEditOperations } from './local-operations';
import { withEvalAnalyzerGate } from './eval-gates';

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

// Expected sentinel copied VERBATIM from production's
// `src/features/ai-panel/services/unity-tools/analyzer-gate.ts`
// (`withUnityAnalyzerGate`):
//
//   `\n\n[Unity analyzers] ${findings.length} error-severity issue(s) introduced by this C# write — ` +
//   `fix them before finishing:\n${note}`
//
// where `note` joins `  • ${f.code ?? f.ruleId}: ${f.message}` per finding.
const VIOLATION_CS =
  'using UnityEngine;\nusing UnityEditor;\npublic class Bad : MonoBehaviour { void Start() { } }';
const EXPECTED_MESSAGE =
  '\n\n[Unity analyzers] 1 error-severity issue(s) introduced by this C# write — fix them before finishing:\n' +
  "  • UNITY0305: 'using UnityEditor;' in a runtime assembly will break player builds. Move this script to an Editor-only assembly/folder, or wrap editor-only code in '#if UNITY_EDITOR'.";

describe('withEvalAnalyzerGate', () => {
  it('appends the exact prod-format message when the write introduces an error-severity finding', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-gate-'));
    try {
      const write = createWriteTool(dir, { operations: localWriteOperations });
      const gated = withEvalAnalyzerGate(write, dir);
      const result = await gated.execute('c1', { path: 'Assets/Bad.cs', content: VIOLATION_CS });
      expect(textOf(result)).toContain(EXPECTED_MESSAGE);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not append any message when the write is clean', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-gate-'));
    try {
      const write = createWriteTool(dir, { operations: localWriteOperations });
      const gated = withEvalAnalyzerGate(write, dir);
      const clean = 'using UnityEngine;\npublic class Good : MonoBehaviour { void Update() { } }';
      const result = await gated.execute('c2', { path: 'Assets/Good.cs', content: clean });
      expect(textOf(result)).not.toContain('[Unity analyzers]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes a .txt write through untouched, even with UnityEditor-shaped content', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-gate-'));
    try {
      const write = createWriteTool(dir, { operations: localWriteOperations });
      const gated = withEvalAnalyzerGate(write, dir);
      const raw = await write.execute('c3', { path: 'Assets/notes.txt', content: 'using UnityEditor;' });
      const result = await gated.execute('c3', { path: 'Assets/notes.txt', content: 'using UnityEditor;' });
      expect(result).toEqual(raw);
      expect(textOf(result)).not.toContain('[Unity analyzers]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('passes a failed edit (target file never existed) through untouched', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-gate-'));
    try {
      const edit = createEditTool(dir, { operations: localEditOperations });
      const gated = withEvalAnalyzerGate(edit, dir);
      const params = { path: 'Assets/Missing.cs', edits: [{ oldText: 'x', newText: 'y' }] };
      const raw = await edit.execute('c4', params);
      const result = await gated.execute('c4', params);
      expect(result).toEqual(raw);
      expect(textOf(result)).not.toContain('[Unity analyzers]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not append message when edit fails (bad oldText) on existing violating file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-gate-'));
    try {
      // Pre-create the file with violating content
      const edit = createEditTool(dir, { operations: localEditOperations });
      await edit.execute('setup', { path: 'Assets/Bad.cs', edits: [{ oldText: '', newText: VIOLATION_CS }] });

      // Now try to edit with bad oldText (will fail, file unchanged)
      const gated = withEvalAnalyzerGate(edit, dir);
      const badParams = { path: 'Assets/Bad.cs', edits: [{ oldText: 'nonexistent', newText: 'x' }] };
      const result = await gated.execute('c5', badParams);
      expect(textOf(result)).not.toContain('[Unity analyzers]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('does not append message when write fails on existing violating file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'eval-gate-'));
    try {
      // Pre-create the file with violating content
      const write = createWriteTool(dir, { operations: localWriteOperations });
      await write.execute('setup', { path: 'Assets/Bad.cs', content: VIOLATION_CS });

      // Stub writeFile to throw
      const failingOperations = {
        ...localWriteOperations,
        writeFile: async () => {
          throw new Error('Write failed');
        },
      };
      const failingWrite = createWriteTool(dir, { operations: failingOperations });
      const gated = withEvalAnalyzerGate(failingWrite, dir);

      // Try to write new content (will fail, file unchanged)
      const result = await gated.execute('c6', { path: 'Assets/Bad.cs', content: 'using UnityEngine;\npublic class NewClass : MonoBehaviour { }' });
      expect(textOf(result)).not.toContain('[Unity analyzers]');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
