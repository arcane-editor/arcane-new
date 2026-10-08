import { afterAll, beforeEach, expect, it, mock } from 'bun:test';
let handler!: (event: { preventDefault: () => void }) => Promise<void>;
let steps: string[] = [];
let dirty: Array<{ path: string; name: string; isDirty: boolean }> = [];
let confirmed = false;
let detach: () => Promise<void> = async () => {};
mock.module('react', () => ({ useEffect: (fn: () => unknown) => fn() }));
mock.module('@tauri-apps/api/window', () => ({ getCurrentWindow: () => ({
  onCloseRequested: async (fn: typeof handler) => { handler = fn; return () => {}; },
  destroy: async () => { steps.push('destroy'); },
}) }));
mock.module('@tauri-apps/plugin-dialog', () => ({ ask: async () => { steps.push('ask'); return confirmed; } }));
mock.module('../stores/workspace', () => ({ useWorkspaceStore: { getState: () => ({ openFiles: dirty }) } }));
mock.module('../stores/ai', () => ({ useAiStore: { getState: () => ({ flushSessionNow: async () => {} }) } }));
mock.module('../stores/checkpoints', () => ({ useCheckpointsStore: { getState: () => ({ flushCheckpointsNow: async () => {} }) } }));
mock.module('../stores/edit-review', () => ({ useEditReviewStore: { getState: () => ({ flushNow: async () => {} }) } }));
mock.module('../features/app-shell', () => ({ flushLayoutPersisters: async () => {} }));
mock.module('../features/lsp', () => ({ settleWorkspaceChanges: async () => { steps.push('settle changes'); } }));
mock.module('../features/debugger', () => ({ dapClient: { stop: async () => { steps.push('detach'); await detach(); } } }));
mock.module('../stores/notifications', () => ({ notify: { error: () => { steps.push('error'); } } }));
mock.module('../utils/tauri-listener', () => ({ safeUnlisten: () => {} }));
const { useCloseGuard } = await import('./useCloseGuard');
afterAll(() => mock.restore());
beforeEach(() => { steps = []; dirty = []; confirmed = false; detach = async () => {}; useCloseGuard(); });
async function close() {
  let prevented = false;
  await handler({ preventDefault: () => { prevented = true; } });
  // Tauri's onCloseRequested wrapper destroys only after its awaited handler.
  if (!prevented) steps.push('destroy');
}
it('a cancelled dirty-document confirmation keeps the debugger and window open', async () => {
  dirty = [{ path: '/fixture/A.cs', name: 'A.cs', isDirty: true }];
  await close();
  expect(steps).toEqual(['settle changes', 'ask']);
});
it('failed detach prevents clean-window closure and reports the failure', async () => {
  detach = async () => { throw new Error('no acknowledgement'); };
  await close();
  expect(steps).toEqual(['settle changes', 'detach', 'error']);
});
it('confirmed closure waits for debugger acknowledgement before destruction', async () => {
  dirty = [{ path: '/fixture/A.cs', name: 'A.cs', isDirty: true }]; confirmed = true;
  let complete!: () => void;
  detach = () => new Promise<void>(resolve => { complete = resolve; });
  const pending = close();
  for (let i = 0; i < 50 && !complete; i++) await Bun.sleep(1);
  expect(steps).not.toContain('destroy');
  complete(); await pending;
  expect(steps).toEqual(['settle changes', 'ask', 'detach', 'destroy']);
});
