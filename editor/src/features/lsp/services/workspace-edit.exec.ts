import { afterAll, beforeEach, expect, it, mock } from 'bun:test';
import type { OpenFile } from '../../../types';
let files: OpenFile[] = [];
let disk = new Map<string, string>();
let calls: string[] = [];
let journal: Array<{ path: string; before: string; after: string; buffer: boolean }> = [];
let afterCommit: (() => void) | undefined;
const workspace = {
  workspacePath: '/fixture',
  get openFiles() { return files; },
  updateFileContent: (path: string, content: string) => { files = files.map(f => f.path === path ? { ...f, content, isDirty: true } : f); },
};
mock.module('../../../stores/workspace', () => ({ useWorkspaceStore: {
  getState: () => workspace,
  setState: (fn: (s: typeof workspace) => { openFiles: OpenFile[] }) => { files = fn(workspace).openFiles; },
} }));
mock.module('../../../stores/notifications', () => ({ notify: { error: () => {}, info: () => {} } }));
mock.module('../../../utils/monaco-instance', () => ({ getMonacoInstance: () => null }));
mock.module('./client', () => ({ setApplyEditHandler: () => {}, LspClient: class {}, LspRequestCanceledError: class extends Error {} }));
mock.module('@tauri-apps/api/core', () => ({ invoke: async (command: string, args: Record<string, unknown>) => {
  calls.push(command);
  if (command === 'workspace_edit_identities') return Object.fromEntries((args.paths as string[]).map(path => [path, path.toLowerCase()]));
  if (command === 'read_file') { if (!disk.has(args.path as string)) throw new Error('missing file'); return disk.get(args.path as string); }
  if (command === 'workspace_edit_apply') {
    journal = args.changes as typeof journal;
    for (const c of journal) if (!c.buffer && disk.get(c.path) !== c.before) throw new Error('disk conflict');
    for (const c of journal) if (!c.buffer) disk.set(c.path, c.after);
    afterCommit?.(); return { id: '1-1', applied: true, recoveryRequired: false };
  }
  if (command === 'workspace_edit_undo') for (const c of journal) if (!c.buffer) disk.set(c.path, c.before);
  return undefined;
} }));
const { applyLspWorkspaceEdit, undoLastWorkspaceEdit } = await import('./workspace-edit');
const { useWorkspaceChangePreview, finishWorkspaceChangePreview } = await import('../../../stores/workspace-change-preview');
const { resetDocumentVersions } = await import('./document-sync');
afterAll(() => mock.restore());
beforeEach(() => { files = []; disk = new Map(); calls = []; afterCommit = undefined; resetDocumentVersions(); });
const replace = (text: string) => [{ range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } }, newText: text }];
async function review(approved: boolean) {
  for (let i = 0; i < 100 && !useWorkspaceChangePreview.getState().files; i++) await Bun.sleep(1);
  expect(useWorkspaceChangePreview.getState().files).not.toBeNull();
  finishWorkspaceChangePreview(approved);
}
it('previews and undoes one operation spanning a dirty buffer and a closed file', async () => {
  files = [{ path: '/fixture/A.cs', name: 'A.cs', content: 'a', diskContent: 'original', isDirty: true }];
  disk.set('/fixture/B.cs', 'b');
  const pending = applyLspWorkspaceEdit({ changes: { 'file:///fixture/A.cs': replace('A'), 'file:///fixture/B.cs': replace('B') } });
  await review(true);
  expect((await pending).filesChanged).toBe(2);
  expect(files[0].content).toBe('A'); expect(disk.get('/fixture/B.cs')).toBe('B');
  await undoLastWorkspaceEdit();
  expect(files[0].content).toBe('a'); expect(files[0].isDirty).toBe(true);
  expect(disk.get('/fixture/B.cs')).toBe('b');
});
it('cancellation and unsupported resource changes never invoke a writer', async () => {
  disk.set('/fixture/A.cs','a');
  const pending = applyLspWorkspaceEdit({ changes: { 'file:///fixture/A.cs': replace('A') } }, { preview: true });
  await review(false); expect((await pending).cancelled).toBe(true);
  const unsupported = await applyLspWorkspaceEdit({ documentChanges: [{ kind: 'rename' }] });
  expect(unsupported.failedFiles).toHaveLength(1);
  expect(calls).not.toContain('workspace_edit_apply');
});
it('a buffer changed during disk commit rolls back closed files and preserves new typing', async () => {
  files = [{ path: '/fixture/A.cs', name: 'A.cs', content: 'a', diskContent: 'a', isDirty: false }];
  disk.set('/fixture/B.cs','b');
  afterCommit = () => workspace.updateFileContent('/fixture/A.cs','user typed');
  const pending = applyLspWorkspaceEdit({ changes: { 'file:///fixture/A.cs': replace('A'), 'file:///fixture/B.cs': replace('B') } });
  await review(true); const summary = await pending;
  expect(summary.failedFiles).toHaveLength(1); expect(summary.filesChanged).toBe(0);
  expect(files[0].content).toBe('user typed'); expect(disk.get('/fixture/B.cs')).toBe('b');
});
it('filesystem aliases target an existing dirty buffer instead of overwriting its disk file', async () => {
  files = [{ path: '/fixture/A.cs', name: 'A.cs', content: 'a dirty', diskContent: 'original', isDirty: true }];
  disk.set('/fixture/A.cs', 'original');
  const result = await applyLspWorkspaceEdit({ changes: { 'file:///fixture/a.cs': replace('A') } });
  expect(result.failedFiles).toEqual([]);
  expect(files[0].content).toBe('A dirty');
  expect(disk.get('/fixture/A.cs')).toBe('original');
});
it('refuses a file changed since a serialization safeguard inspected it', async () => {
  disk.set('/fixture/A.cs', 'changed');
  const result = await applyLspWorkspaceEdit({ changes: { 'file:///fixture/A.cs': replace('A') } }, { expectedTexts: new Map([['/fixture/A.cs', 'original']]) });
  expect(result.failedFiles).toHaveLength(1);
  expect(calls).not.toContain('workspace_edit_apply');
});
