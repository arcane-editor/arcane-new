import { describe, expect, it } from 'bun:test';
import { createAutomationTools, type AutomationDeps } from './automation-tools';
import { TaskRunContext } from './task-context';
import type { AutomationReport } from '../../../../types/automation';

function harness(overrides: Partial<AutomationDeps> = {}) {
  const task = new TaskRunContext('test', '/game', 20); const calls: string[] = [];
  task.scenarios.set(play.scenario.id, JSON.stringify(play.scenario));
  const deps: AutomationDeps = {
    protocol: () => 5, compile: async () => ({ status: 'report', report: { started: false, success: true, errors: 0 } }),
    checkpoint: async () => { calls.push('checkpoint'); },
    author: async (op) => { calls.push('author'); return { operationId: op.operationId, status: 'passed' }; },
    authorStatus: async (id) => ({ operationId: id, status: 'unsupported' }),
    verifyScene: async () => ({ operationId: 'scene', status: 'passed' }),
    play: async (id) => ({ operationId: id, taskId: 'test', status: 'queued' }),
    status: async (id) => ({ operationId: id, taskId: 'test', status: 'passed', cleanupComplete: true, observations: [{ step: 1, label: 'moved', passed: true }], captures: [{ label: 'game', mimeType: 'image/png', data: 'AA==' }] }),
    cancel: async (id) => { calls.push('cancel'); return { operationId: id, status: 'cancelled' }; },
    wait: async () => {}, ...overrides,
  };
  const tools = createAutomationTools(task, 'gameplay-verification', deps);
  return { task, calls, tool: (name: string) => tools.find((t) => t.name === name)! };
}
const author = { operationId: 'build', scenePath: 'Assets/Main.unity', ownedRoot: 'Level', outputs: ['Assets/Main.unity'], actions: [] };
const play = { operationId: 'play', scenario: { id: 'move', seed: 1, scenePath: 'Assets/Main.unity', steps: [{ kind: 'input', device: 'keyboard', control: 'space', value: 1 }, { kind: 'assert', target: 'Player', property: 'activeSelf', expected: true }] } };
describe('automation tools', () => {
  it('blocks authoring on unknown compilation and checkpoints before dispatch', async () => {
    const unknown = harness({ compile: async () => ({ status: 'unknown', reason: 'bridge-lost' }) });
    await unknown.tool('unity_author').execute('id', author); expect(unknown.calls).toEqual([]);
    const live = harness(); await live.tool('unity_author').execute('id', author); expect(live.calls).toEqual(['checkpoint', 'author']);
  });
  it('returns an existing operation instead of applying it twice', async () => {
    const h = harness({ authorStatus: async (id) => ({ operationId: id, status: 'passed' }) });
    await h.tool('unity_author').execute('id', author); expect(h.calls).toEqual([]);
  });
  it('invalidates evidence when an authoring outcome is unknown', async () => {
    const h = harness({ author: async () => { throw new Error('Disconnected'); } });
    const result = await h.tool('unity_author').execute('id', author);
    expect(result.isError).toBe(true); expect(h.task.revision).toBe(1); expect(JSON.stringify(result)).toContain('unknown');
  });
  it('waits past acknowledgement and returns actual captured images', async () => {
    const h = harness(); const result = await h.tool('unity_playtest').execute('id', play);
    expect(h.task.evidence.get('gameplay:move')?.status).toBe('passed');
    expect(result.content.some((c) => c.type === 'image')).toBe(true);
  });
  it('records unsupported input as unsupported and cancels an interrupted wait', async () => {
    const report: AutomationReport = { operationId: 'play', status: 'unsupported', reason: 'Legacy input' };
    const h = harness({ play: async () => report }); await h.tool('unity_playtest').execute('id', play);
    expect(h.task.evidence.get('gameplay:move')?.status).toBe('unsupported');
    const interrupted = harness({ wait: async () => { throw new Error('Cancelled'); } });
    await interrupted.tool('unity_playtest').execute('id', play); expect(interrupted.calls).toContain('cancel');
    expect(interrupted.task.evidence.get('gameplay:move')?.status).toBe('not-run');
  });
  it('does not call unavailable bridge methods', async () => {
    const h = harness({ protocol: () => 4 });
    await expect(h.tool('unity_author').execute('id', author)).rejects.toThrow('protocol 5'); expect(h.calls).toEqual([]);
  });
});

it('waits for Play Mode cleanup after a terminal assertion result', async () => {
  let polls = 0;
  const h = harness({ status: async (id) => ({ operationId: id, taskId: 'test', status: 'passed', cleanupComplete: ++polls >= 2 }) });
  await h.tool('unity_playtest').execute('id', play);
  expect(polls).toBeGreaterThanOrEqual(3); expect(h.task.evidence.get('gameplay:move')?.status).toBe('passed');
});
it('recovers a lost start acknowledgement by status without starting twice', async () => {
  let starts = 0;
  const h = harness({ play: async () => { starts++; throw new Error('Response timed out'); } });
  const result = await h.tool('unity_playtest').execute('id', play);
  expect(starts).toBe(1); expect(result.isError).toBe(false);
  expect(h.task.evidence.get('gameplay:move')?.status).toBe('passed');
});
it('never accepts or cancels another task after a lost acknowledgement', async () => {
  const h = harness({ play: async () => { throw new Error('Disconnected'); }, status: async (id) => ({ operationId: id, taskId: 'another-task', status: 'passed', cleanupComplete: true }) });
  const result = await h.tool('unity_playtest').execute('id', play);
  expect(result.isError).toBe(true); expect(h.calls).not.toContain('cancel');
  expect(h.task.evidence.get('gameplay:move')?.status).toBe('not-run');
});
it('requires a declared suite and preserves every scenario when new coverage is added', async () => {
  const h = harness(); h.task.scenarios.clear();
  expect((await h.tool('unity_playtest').execute('id', play)).isError).toBe(true);
  const register = h.tool('unity_register_scenarios');
  expect((await register.execute('suite', { scenarios: [play.scenario] })).isError).toBe(false);
  const added = { ...play.scenario, id: 'restart' };
  await register.execute('more', { scenarios: [added] });
  expect([...h.task.scenarios.keys()]).toEqual(['move', 'restart']);
  expect((await register.execute('weaken', { scenarios: [{ ...play.scenario, seed: 99 }] })).isError).toBe(true);
  expect(h.task.scenarios.get('move')).toBe(JSON.stringify(play.scenario));
});
it('does not allow a new operation to replace assertions from an earlier required scenario', async () => {
  const h = harness(); await h.tool('unity_playtest').execute('id', play);
  const result = await h.tool('unity_playtest').execute('id2', { ...play, operationId: 'second', scenario: { ...play.scenario, steps: [...play.scenario.steps.slice(0, 1), { kind: 'assert', target: 'SomethingElse', expected: true }] } });
  expect(result.isError).toBe(true);
});
it('requires the reviewer to actually fetch current rendered frames before a visual pass', async () => {
  const task = new TaskRunContext('review', '/game', 10); task.requirements.add('visual-review');
  task.record({ id: 'game', kind: 'gameplay', revision: 0, status: 'passed', summary: 'passed', operationId: 'play', artifacts: [] });
  const tools = createAutomationTools(task, 'independent-review', { protocol: () => 5, status: async () => ({ operationId: 'play', status: 'passed', captures: [{ label: 'frame', mimeType: 'image/png', data: 'AA==' }] }) } as unknown as AutomationDeps);
  const submit = tools.find((t) => t.name === 'submit_review')!;
  const args = { passed: true, summary: 'Reviewed', visual: { operationId: 'play', passed: true, summary: 'Readable' } };
  await submit.execute('one', args); expect(task.evidence.get('visual-review')?.status).toBe('not-run');
  await tools.find((t) => t.name === 'unity_playtest_status')!.execute('fetch', { operationId: 'play' });
  await submit.execute('two', args); expect(task.evidence.get('visual-review')?.status).toBe('passed');
  task.changed('Assets/HUD.uxml'); await submit.execute('three', args); expect(task.evidence.get('visual-review')?.status).toBe('not-run');
});
