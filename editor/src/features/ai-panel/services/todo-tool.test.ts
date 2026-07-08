import { describe, it, expect } from 'bun:test';
import { createTodoTool, MAX_TODO_ITEMS, type TodoItem } from './todo-tool';

function textOf(result: { content: { type: string; text?: string }[] }): string {
  return result.content.map((c) => c.text ?? '').join('\n');
}

describe('todo_update tool', () => {
  it('has the expected name and schema shape', () => {
    const tool = createTodoTool(() => {});
    expect(tool.name).toBe('todo_update');
    expect(tool.description).toContain('pending');
    expect(tool.description).toContain('in_progress');
    expect(tool.description).toContain('done');
  });

  it('replaces the full list and reports the confirmation counts', async () => {
    let captured: TodoItem[] | undefined;
    const tool = createTodoTool((items) => {
      captured = items;
    });

    const result = await tool.execute('c1', {
      items: [
        { text: 'Write the tool', status: 'done' },
        { text: 'Wire it into agent-service', status: 'in_progress' },
        { text: 'Update the prompt', status: 'pending' },
        { text: 'Ship the eval stub', status: 'pending' },
      ],
    });

    expect(captured).toEqual([
      { text: 'Write the tool', status: 'done' },
      { text: 'Wire it into agent-service', status: 'in_progress' },
      { text: 'Update the prompt', status: 'pending' },
      { text: 'Ship the eval stub', status: 'pending' },
    ]);
    expect(textOf(result)).toBe('Todo list updated: 1 done / 1 in progress / 2 pending');
  });

  it('a later call with a shorter list fully replaces the previous one (no merge)', async () => {
    const seen: TodoItem[][] = [];
    const tool = createTodoTool((items) => seen.push(items));

    await tool.execute('c1', {
      items: [
        { text: 'A', status: 'pending' },
        { text: 'B', status: 'pending' },
      ],
    });
    await tool.execute('c2', { items: [{ text: 'A', status: 'done' }] });

    expect(seen).toEqual([
      [
        { text: 'A', status: 'pending' },
        { text: 'B', status: 'pending' },
      ],
      [{ text: 'A', status: 'done' }],
    ]);
  });

  it('rejects an invalid status without calling onUpdate, with a guiding error message', async () => {
    let called = false;
    const tool = createTodoTool(() => {
      called = true;
    });

    const result = await tool.execute('c1', {
      items: [{ text: 'Do the thing', status: 'completed' }],
    });

    expect(called).toBe(false);
    const text = textOf(result);
    expect(text).toContain('Error');
    expect(text).toContain('completed');
    expect(text).toContain('pending, in_progress, done');
  });

  it('rejects an item with empty text without calling onUpdate', async () => {
    let called = false;
    const tool = createTodoTool(() => {
      called = true;
    });

    const result = await tool.execute('c1', { items: [{ text: '  ', status: 'pending' }] });

    expect(called).toBe(false);
    expect(textOf(result)).toContain('Error');
  });

  it('caps at MAX_TODO_ITEMS, truncating the excess and noting it in the result', async () => {
    let captured: TodoItem[] | undefined;
    const tool = createTodoTool((items) => {
      captured = items;
    });

    const items = Array.from({ length: MAX_TODO_ITEMS + 5 }, (_, i) => ({
      text: `Task ${i + 1}`,
      status: 'pending' as const,
    }));

    const result = await tool.execute('c1', { items });

    expect(captured).toHaveLength(MAX_TODO_ITEMS);
    expect(captured?.[0].text).toBe('Task 1');
    expect(captured?.[MAX_TODO_ITEMS - 1].text).toBe(`Task ${MAX_TODO_ITEMS}`);

    const text = textOf(result);
    expect(text).toContain(`Todo list updated: 0 done / 0 in progress / ${MAX_TODO_ITEMS} pending`);
    expect(text).toContain(`capped at ${MAX_TODO_ITEMS}`);
    expect(text).toContain('5 excess item(s) dropped');
  });

  // NOTE: the default `onUpdate` (no argument) reaches the ai store via a
  // dynamic import — deliberately NOT exercised here. `stores/ai.ts` pulls in
  // `stores/workspace.ts` → `features/editor` → `@monaco-editor/react` →
  // `stores/theme.ts`'s `document.documentElement` side effect, which throws
  // ("document is not defined") under Bun's DOM-less runtime — the exact
  // hazard `unity-tools/lsp-gate.ts`'s DI-seam doc comment describes. Every
  // test above injects a fake `onUpdate`, matching `di-seam.test.ts`'s
  // convention for this class of tool.
});
