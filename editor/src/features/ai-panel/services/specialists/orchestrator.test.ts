import { describe, expect, it } from 'bun:test';
import { Type } from '@sinclair/typebox';
import { SpecialistOrchestrator } from './orchestrator';
import { TaskRunContext } from './task-context';
import { AssistantMessageEventStream } from '../vendor/event-stream';
import type { Context, StreamFn } from '../vendor/types';
import type { SpecialistTask } from './contracts';

const assignment = (id: string, role: SpecialistTask['role'] = 'gameplay'): SpecialistTask => ({ id, role, objective: `Build ${id}`, targets: ['Assets/Scripts'], dependencies: [], acceptanceCriteria: ['Works'] });
function harness(toolName?: string, toolPath = 'Assets/Scripts/A.cs') {
  const task = new TaskRunContext('test', '/game', 20); task.criteria.push('Original requirement');
  const seen: Record<string, Context[]> = {}; const writes: string[] = [];
  const runner = new SpecialistOrchestrator(task, {
    effort: 'mid', contextWindow: 32768, context: () => 'Unity 6', onProgress: () => {},
    tools: () => [{ name: 'write', label: 'write', description: 'write', parameters: Type.Object({ path: Type.String() }), execute: async (_id, raw) => { const { path } = raw as { path: string }; writes.push(path); task.changed(path); return { content: [{ type: 'text', text: 'written' }] }; } }],
    stream: (id): StreamFn => (context) => {
      (seen[id] ??= []).push(context);
      const s = new AssistantMessageEventStream();
      const call = toolName && seen[id].length === 1;
      s.push({ type: 'done', message: { role: 'assistant', content: call ? [{ type: 'toolCall', id: 'same-id', name: toolName, arguments: { path: toolPath } }] : [{ type: 'text', text: `${id} finished` }], stopReason: call ? 'toolUse' : 'stop', timestamp: 1 } });
      return s;
    },
  });
  return { task, seen, writes, runner };
}
describe('specialist execution', () => {
  it('locks authored scene targets into acceptance independently of specialist routing', async () => {
    const h = harness();
    h.task.criteria.length = 0;
    const setAcceptance = h.runner.tools().find((tool) => tool.name === 'set_acceptance')!;
    const result = await setAcceptance.execute('accept', {
      criteria: ['The level is editable before Play'],
      required: ['scene-persistence'],
      scenes: [
        { scenePath: 'Assets/Scenes/Main.unity', root: 'AuthoredLevel', requireRepresentativeLevel: true },
        { scenePath: 'Assets/Scenes/Menu.unity', root: 'MenuUI', requireRepresentativeLevel: false },
      ],
    });
    expect(result.isError).not.toBe(true);
    expect(h.task.requiredScenes).toEqual(new Map([
      ['Assets/Scenes/Main.unity#AuthoredLevel', { scenePath: 'Assets/Scenes/Main.unity', root: 'AuthoredLevel', requireRepresentativeLevel: true }],
      ['Assets/Scenes/Menu.unity#MenuUI', { scenePath: 'Assets/Scenes/Menu.unity', root: 'MenuUI', requireRepresentativeLevel: false }],
    ]));
    expect(h.task.sceneRequiresRepresentativeLevel('Assets/Scenes/Main.unity', 'AuthoredLevel')).toBe(true);
    expect(h.task.sceneRequiresRepresentativeLevel('Assets/Scenes/Menu.unity', 'MenuUI')).toBe(false);
  });
  it('uses separate histories and keeps a stable specialist history on followup', async () => {
    const h = harness();
    await h.runner.run(assignment('movement')); await h.runner.run(assignment('ui', 'ui-building'));
    expect(JSON.stringify(h.seen.ui[0].messages)).not.toContain('movement finished');
    await h.runner.run(assignment('movement'));
    expect(JSON.stringify(h.seen.movement[1].messages)).toContain('movement finished');
    expect(h.task.calls).toBe(3);
  });
  it('blocks out-of-scope writes before the tool runs', async () => {
    const h = harness('write', 'Assets/Other.cs');
    await h.runner.run(assignment('movement')); expect(h.writes).toEqual([]);
    expect(JSON.stringify(h.seen.movement[1].messages)).toContain('outside');
  });
  it('does not give a reviewer write or delegation tools', async () => {
    const h = harness('write'); await h.runner.run(assignment('review', 'independent-review'));
    expect(h.seen.review[0].tools).toEqual([]); expect(h.writes).toEqual([]);
  });
  it('does not launch unmet dependencies or change an existing agent’s permissions', async () => {
    const h = harness();
    await expect(h.runner.run({ ...assignment('movement'), dependencies: ['missing'] })).rejects.toThrow('dependencies');
    await h.runner.run(assignment('movement'));
    await expect(h.runner.run(assignment('movement', 'independent-review'))).rejects.toThrow('role or targets');
  });
  it('does not retain a completed dependency after its next attempt fails', async () => {
    const h = harness(); await h.runner.run(assignment('movement'));
    expect(h.task.completed.has('movement')).toBe(true);
    h.task.calls = h.task.maxCalls;
    expect((await h.runner.run(assignment('movement'))).status).toBe('failed');
    expect(h.task.completed.has('movement')).toBe(false);
    await expect(h.runner.run({ ...assignment('ui', 'ui-building'), dependencies: ['movement'] })).rejects.toThrow('dependencies');
  });
});
