// Isolated because Bun's module mocks persist across unrelated test files.
import { afterAll, beforeEach, expect, it, mock } from 'bun:test';
let requestedId: string | undefined;
mock.module('../../unity-bridge', () => ({ bridgeRpc: { runTests: async (_mode: string, _filter: string, id: string) => { requestedId = id; } } }));
mock.module('../../../stores/workspace', () => ({ useWorkspaceStore: { getState: () => ({ workspacePath: '/fixture' }) } }));
mock.module('../../../stores/unity', () => ({ useUnityStore: { getState: () => ({ connected: true }) } }));
mock.module('../../../stores/project-context', () => ({ useProjectContextStore: { getState: () => ({ unityVersion: '6000.3' }) } }));
mock.module('../../../stores/debug', () => ({ useDebugStore: { getState: () => ({ configurationReady: true, status: 'running' }) } }));
mock.module('../../../stores/notifications', () => ({ notify: { error: () => {}, warning: () => {}, info: () => {} } }));
const { useTestStore } = await import('./test-store');
afterAll(() => mock.restore());
beforeEach(() => { requestedId = undefined; useTestStore.setState({ run: null, results: new Map(), lastRunCompleted: null }); });

it('queues an identified run before events and rejects unrelated progress/completion', async () => {
  await useTestStore.getState().runAll('PlayMode');
  expect(requestedId).toBeTruthy();
  useTestStore.getState().applyEvent({ phase: 'runStarted', runId: 'older', total: 99 });
  useTestStore.getState().applyRunCompleted({ runId: 'older', ok: true, passed: 99 });
  useTestStore.getState().applyEvent({ phase: 'runFinished', runId: null });
  expect(useTestStore.getState().run?.active).toBe(true);
  expect(useTestStore.getState().run?.runId).toBe(requestedId);
  useTestStore.getState().applyEvent({ phase: 'runStarted', runId: requestedId, total: 1 });
  expect(useTestStore.getState().run?.mode).toBe('PlayMode');
  useTestStore.getState().applyEvent({ phase: 'testFinished', runId: requestedId, fullName: 'Fixture.Case(1)', status: 'Passed' });
  useTestStore.getState().applyEvent({ phase: 'testFinished', runId: requestedId, fullName: 'Fixture.Case(1)', status: 'Passed' });
  expect(useTestStore.getState().run?.done).toBe(1);
  useTestStore.getState().applyRunCompleted({ runId: requestedId!, ok: true, passed: 1 });
  expect(useTestStore.getState().run?.active).toBe(false);
});

it('keeps inconclusive results distinct and does not start a second active run', async () => {
  await useTestStore.getState().runAll('EditMode');
  const id = requestedId;
  await useTestStore.getState().runAll('PlayMode');
  expect(requestedId).toBe(id);
  useTestStore.getState().applyEvent({ phase: 'testFinished', runId: id, fullName: 'Fixture.Uncertain', status: 'Inconclusive' });
  expect(useTestStore.getState().results.get('Fixture.Uncertain')?.status).toBe('inconclusive');
});
