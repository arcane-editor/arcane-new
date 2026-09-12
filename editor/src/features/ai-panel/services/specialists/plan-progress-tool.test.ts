import { describe, expect, it } from 'bun:test';
import { createPlanProgressTool, markPlanTodoDone } from './plan-progress-tool';

const PLAN_PATH = '/game/.unityide/plans/build-level.aplan';
const PLAN = [
  '# Build level',
  '',
  '- [ ] T1 [easy] Add movement',
  '- [ ] T2 [hard] Author the editable level',
  '- [ ] T3 [easy] Add movement',
  '',
].join('\r\n');

describe('markPlanTodoDone', () => {
  it('ticks only the exact todo id and preserves the rest of the document byte-for-byte', () => {
    const result = markPlanTodoDone(PLAN, 'T2');
    expect(result.changed).toBe(true);
    expect(result.content).toBe(PLAN.replace('- [ ] T2', '- [x] T2'));
  });

  it('is idempotent when the todo is already complete', () => {
    const done = PLAN.replace('- [ ] T2', '- [X] T2');
    expect(markPlanTodoDone(done, 't2')).toEqual({ content: done, changed: false });
  });

  it('rejects missing and duplicate ids instead of guessing', () => {
    expect(() => markPlanTodoDone(PLAN, 'T9')).toThrow('not found');
    expect(() => markPlanTodoDone(`${PLAN}- [ ] T2 Duplicate\n`, 'T2')).toThrow('appears 2 times');
  });
});

describe('plan_progress tool', () => {
  it('uses an atomic compare-before-write and reports the persisted todo', async () => {
    const writes: Array<{ path: string; content: string; expected: string }> = [];
    const tool = createPlanProgressTool({
      workspacePath: '/game',
      planPath: PLAN_PATH,
      read: async () => PLAN,
      writeIfUnchanged: async (path, content, expected) => {
        writes.push({ path, content, expected });
        return true;
      },
      isDirty: () => false,
    });

    const result = await tool.execute('call', { todoId: 'T2' });
    expect(result.isError).not.toBe(true);
    expect(writes).toEqual([{ path: PLAN_PATH, content: PLAN.replace('- [ ] T2', '- [x] T2'), expected: PLAN }]);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Marked T2 complete in build-level.aplan.' });
  });

  it('refuses dirty buffers and concurrent disk changes without writing over them', async () => {
    let writes = 0;
    const dirty = createPlanProgressTool({
      workspacePath: '/game', planPath: PLAN_PATH,
      read: async () => PLAN,
      writeIfUnchanged: async () => { writes++; return true; },
      isDirty: () => true,
    });
    expect((await dirty.execute('call', { todoId: 'T1' })).isError).toBe(true);
    expect(writes).toBe(0);

    const conflict = createPlanProgressTool({
      workspacePath: '/game', planPath: PLAN_PATH,
      read: async () => PLAN,
      writeIfUnchanged: async () => false,
      isDirty: () => false,
    });
    const result = await conflict.execute('call', { todoId: 'T1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({
      type: 'text',
      text: 'The plan changed on disk while T1 was being updated. Re-read the plan and retry.',
    });
  });

  it('cannot be pointed at a different file', () => {
    expect(() => createPlanProgressTool({
      workspacePath: '/game',
      planPath: '/game/Assets/Other.aplan',
      read: async () => PLAN,
      writeIfUnchanged: async () => true,
      isDirty: () => false,
    })).toThrow('outside');
  });

  it('runs the host real-path guard before reading or writing', async () => {
    let read = false;
    const tool = createPlanProgressTool({
      workspacePath: '/game', planPath: PLAN_PATH,
      assertAllowed: async () => { throw new Error('symlink leaves plan directory'); },
      read: async () => { read = true; return PLAN; },
      writeIfUnchanged: async () => true,
      isDirty: () => false,
    });
    const result = await tool.execute('call', { todoId: 'T1' });
    expect(result.isError).toBe(true);
    expect(result.content[0]).toEqual({ type: 'text', text: 'Could not access build-level.aplan: symlink leaves plan directory' });
    expect(read).toBe(false);
  });
});
