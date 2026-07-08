/**
 * `todo_update` — in-loop todo list tool (P3.5).
 *
 * Full-list-replace schema, deliberately: the frozen model lineup includes a
 * 32B model that doesn't reliably reason about diff/patch semantics (add this
 * item, remove that one, reorder). A full replace only asks the model to
 * restate the list it should already be tracking, which weak models handle
 * far more reliably than an incremental API would.
 *
 * Bun-safe by construction: this module has NO store import at module scope,
 * so it (and its default `onUpdate`) can be constructed directly under Bun —
 * both in this file's own tests and in the eval harness
 * (`tooling/unity-eval/run-task.ts`'s `buildTools`, which wires the SAME tool
 * for tool-list parity with prod). The production default reaches the ai
 * store via a dynamic import, mirroring the DI seam documented in
 * `unity-tools/lsp-gate.ts`.
 */

import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from './vendor/types';

export const TODO_STATUSES = ['pending', 'in_progress', 'done'] as const;
export type TodoStatus = (typeof TODO_STATUSES)[number];

export interface TodoItem {
  text: string;
  status: TodoStatus;
}

export type TodoUpdateCallback = (items: TodoItem[]) => void;

/** Excess items beyond this cap are dropped, with a note appended to the tool result. */
export const MAX_TODO_ITEMS = 20;

const todoItemSchema = Type.Object({
  text: Type.String({ description: 'Short description of the task.' }),
  status: Type.Union(
    [Type.Literal('pending'), Type.Literal('in_progress'), Type.Literal('done')],
    { description: 'pending | in_progress | done' },
  ),
});

const todoUpdateSchema = Type.Object({
  items: Type.Array(todoItemSchema, {
    description:
      'The FULL updated todo list — include every item you want to keep, not just the ones that changed.',
  }),
});

function txt(text: string): AgentToolResult {
  return { content: [{ type: 'text', text }] };
}

function isValidStatus(s: unknown): s is TodoStatus {
  return typeof s === 'string' && (TODO_STATUSES as readonly string[]).includes(s);
}

/**
 * Production default: pushes the parsed list straight to `arcanePlan` in the
 * ai store. Loaded via dynamic import so this file stays statically
 * Bun-safe — see the module doc comment.
 */
async function pushToArcaneStore(items: TodoItem[]): Promise<void> {
  const { useAiStore } = await import('../../../stores/ai');
  useAiStore.getState().setArcanePlan(items);
}

/**
 * `onUpdate` is injectable (tests + the eval harness's state-capturing no-op,
 * for tool-list parity — see `run-task.ts`'s `buildTools`). Defaults to
 * `pushToArcaneStore` for production use.
 */
export function createTodoTool(
  onUpdate: TodoUpdateCallback = (items) => void pushToArcaneStore(items),
): AgentTool {
  return {
    name: 'todo_update',
    label: 'update todo list',
    description:
      'Maintain your task list: call with the FULL updated list each time (not just the changed items) — ' +
      'every item you want to keep must be included. statuses: pending | in_progress | done. Use this for ' +
      'any multi-step task so progress stays visible and you can pick up where you left off.',
    parameters: todoUpdateSchema,
    async execute(_toolCallId, params): Promise<AgentToolResult> {
      const { items } = params as Static<typeof todoUpdateSchema>;

      if (!Array.isArray(items)) {
        return txt('Error: "items" must be an array of { text, status }. No changes were applied.');
      }

      for (let i = 0; i < items.length; i++) {
        const item = items[i] as { text?: unknown; status?: unknown };
        if (typeof item.text !== 'string' || item.text.trim() === '') {
          return txt(
            `Error: item ${i + 1} is missing a non-empty "text" string. No changes were applied.`,
          );
        }
        if (!isValidStatus(item.status)) {
          return txt(
            `Error: item ${i + 1} has invalid status ${JSON.stringify(item.status)}. ` +
              'Must be one of: pending, in_progress, done. No changes were applied.',
          );
        }
      }

      const truncated = items.length > MAX_TODO_ITEMS;
      const kept: TodoItem[] = (truncated ? items.slice(0, MAX_TODO_ITEMS) : items).map((i) => ({
        text: (i as { text: string }).text,
        status: (i as { status: TodoStatus }).status,
      }));

      onUpdate(kept);

      const done = kept.filter((i) => i.status === 'done').length;
      const inProgress = kept.filter((i) => i.status === 'in_progress').length;
      const pending = kept.filter((i) => i.status === 'pending').length;

      let result = `Todo list updated: ${done} done / ${inProgress} in progress / ${pending} pending`;
      if (truncated) {
        result +=
          ` (list capped at ${MAX_TODO_ITEMS} items; ${items.length - MAX_TODO_ITEMS} excess item(s) dropped)`;
      }
      return txt(result);
    },
  };
}
