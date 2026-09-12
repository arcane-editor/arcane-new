import { describe, expect, it } from 'bun:test';
import { TaskRunContext, taskPathAllowed } from './task-context';

describe('task execution ownership', () => {
  it('shares a hard budget between coordinator and specialists without leaking to another task', () => {
    const first = new TaskRunContext('first', '/game', 2);
    const second = new TaskRunContext('second', '/game', 2);
    first.takeCall('coordinator'); first.takeCall('gameplay');
    expect(() => first.takeCall('review')).toThrow('budget');
    second.takeCall('review'); expect(second.calls).toBe(1);
  });
  it('serializes mutations until the first operation actually settles', async () => {
    const task = new TaskRunContext('test', '/game', 10);
    const events: string[] = []; let release!: () => void;
    const a = task.exclusive(async () => { events.push('a'); await new Promise<void>((r) => { release = r; }); events.push('a-done'); });
    const b = task.exclusive(async () => { events.push('b'); });
    await Promise.resolve(); expect(events).toEqual(['a']); release();
    await Promise.all([a, b]); expect(events).toEqual(['a', 'a-done', 'b']);
  });
  it('does not start queued writes after cancellation', async () => {
    const task = new TaskRunContext('test', '/game', 10);
    task.abort.abort(); let wrote = false;
    await expect(task.exclusive(async () => { wrote = true; })).rejects.toThrow('cancelled');
    expect(wrote).toBe(false);
  });
  it('invalidates evidence on any relevant mutation and never treats unsupported as passed', () => {
    const task = new TaskRunContext('test', '/game', 10); task.criteria.push('Move with input'); task.requirements.add('gameplay');
    task.record({ id: 'game', kind: 'gameplay', status: 'passed', revision: 0, summary: 'Moved', artifacts: [] });
    expect(task.canFinish()).toBe(true);
    task.changed('Assets/Mover.cs'); expect(task.canFinish()).toBe(false);
    task.record({ id: 'game', kind: 'gameplay', status: 'unsupported', revision: 1, summary: 'Legacy input', artifacts: [] });
    expect(task.canFinish()).toBe(false);
  });
  it('stops after two repair rounds make no progress and never exceeds five rounds', () => {
    const task = new TaskRunContext('test', '/game', 10);
    expect(task.beginRepair()).toBe(true); expect(task.beginRepair()).toBe(true); expect(task.beginRepair()).toBe(false);
    const improving = new TaskRunContext('test', '/game', 10);
    improving.requirements.add('gameplay');
    improving.scenarios.set('move', '{}');
    for (let i = 0; i < 5; i++) {
      improving.record({ id: 'gameplay:move', scenarioId: 'move', kind: 'gameplay', revision: 0, status: 'failed', summary: 'Progressively further', artifacts: [], assertions: { passed: i, total: 5 } });
      expect(improving.beginRepair()).toBe(true);
    }
    expect(improving.beginRepair()).toBe(false);
  });
  it('enforces target boundaries, traversal and independent acceptance fixtures', () => {
    expect(taskPathAllowed('Assets/Scripts/Mover.cs', ['Assets/Scripts'], '/game')).toBe(true);
    expect(taskPathAllowed('/game/Assets/Scripts/Mover.cs', ['Assets/Scripts'], '/game')).toBe(true);
    expect(taskPathAllowed('Assets/Scripts/../../secrets', ['Assets'], '/game')).toBe(false);
    expect(taskPathAllowed('Assets/Tests/UnityIDEAcceptance/Test.cs', ['Assets'], '/game')).toBe(false);
    expect(taskPathAllowed('Assets/ScriptsOther/A.cs', ['Assets/Scripts'], '/game')).toBe(false);
  });
});

it('serializes two separate tasks targeting the same workspace', async () => {
  const first = new TaskRunContext('one', '/shared', 5), second = new TaskRunContext('two', '/shared', 5);
  let release!: () => void; let ran = false;
  const a = first.exclusive(() => new Promise<void>((r) => { release = r; }));
  await Promise.resolve();
  const b = second.exclusive(async () => { ran = true; });
  await Promise.resolve(); expect(ran).toBe(false); release(); await Promise.all([a, b]); expect(ran).toBe(true);
});
it('restores a task without resetting budgets or accepting pre-interruption evidence', () => {
  const task = new TaskRunContext('one', '/shared', 2); task.criteria.push('Works'); task.requirements.add('compile');
  task.takeCall('one'); task.beginRepair();
  task.record({ id: 'compile', kind: 'compile', status: 'passed', revision: 0, summary: 'Clean', artifacts: [] });
  const restored = TaskRunContext.restore(task.snapshot('running'));
  expect(restored.calls).toBe(1); expect(restored.repairCycles).toBe(1); expect(restored.canFinish()).toBe(false);
  restored.takeCall('two'); expect(() => restored.takeCall('three')).toThrow('budget');
});
it('requires every registered gameplay scenario to pass at the current revision', () => {
  const task = new TaskRunContext('one', '/shared', 2); task.criteria.push('Move and restart'); task.requirements.add('gameplay');
  task.scenarios.set('move', '{}'); task.scenarios.set('restart', '{}');
  task.record({ id: 'move', kind: 'gameplay', scenarioId: 'move', revision: 0, status: 'passed', summary: 'Moved', artifacts: [] });
  expect(task.canFinish()).toBe(false);
  task.record({ id: 'restart', kind: 'gameplay', scenarioId: 'restart', revision: 0, status: 'passed', summary: 'Restarted', artifacts: [] });
  expect(task.canFinish()).toBe(true);
});
it('does not count reworded failures, fresh operation IDs, or scene rechecks as repair progress', () => {
  const task = new TaskRunContext('one', '/shared', 20);
  task.requirements.add('scene-persistence'); task.requirements.add('review');
  for (let attempt = 0; attempt < 3; attempt++) {
    task.record({ id: 'scene-' + attempt, kind: 'scene-persistence', status: 'passed', revision: 0, summary: 'Saved', artifacts: [] });
    task.record({ id: 'review', kind: 'review', status: 'failed', revision: 0, summary: 'Different failure wording ' + attempt, artifacts: [] });
    expect(task.beginRepair()).toBe(attempt < 2);
  }
});
