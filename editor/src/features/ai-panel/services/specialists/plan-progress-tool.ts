import { Type, type Static } from '@sinclair/typebox';
import type { AgentTool, AgentToolResult } from '../vendor/types';
import { resolveWithinRoot } from '../vendor/tools/path-utils';

const planProgressSchema = Type.Object({
  todoId: Type.String({
    pattern: '^[Tt][1-9][0-9]*$',
    description: 'Stable todo id from the approved plan, for example T2',
  }),
});

type PlanProgressInput = Static<typeof planProgressSchema>;

export interface PlanProgressOperations {
  workspacePath: string;
  planPath: string;
  assertAllowed?: (path: string) => Promise<void>;
  read(path: string): Promise<string>;
  writeIfUnchanged(path: string, content: string, expectedContent: string): Promise<boolean>;
  isDirty(path: string): boolean;
  onWritten?: (path: string) => Promise<void> | void;
}

function result(text: string, isError = false): AgentToolResult {
  return { content: [{ type: 'text', text }], ...(isError ? { isError: true } : {}) };
}

/**
 * Mark one stable T<n> checkbox complete without reformatting any other byte.
 * IDs must be unique: a hand-edited ambiguous plan is returned to the model
 * instead of selecting a similarly named item by position or title.
 */
export function markPlanTodoDone(doc: string, rawTodoId: string): { content: string; changed: boolean } {
  const todoId = rawTodoId.toUpperCase();
  if (!/^T[1-9][0-9]*$/.test(todoId)) throw new Error(`Invalid plan todo id: ${rawTodoId}`);

  const matches = [...doc.matchAll(/^(\s*[-*]\s+\[)( |x|X)(\]\s+)(T\d+)(?=\s|$)/gim)]
    .filter((match) => match[4].toUpperCase() === todoId);
  if (matches.length === 0) throw new Error(`${todoId} was not found in the approved plan.`);
  if (matches.length !== 1) throw new Error(`${todoId} appears ${matches.length} times in the approved plan.`);

  const match = matches[0];
  if (match[2].toLowerCase() === 'x') return { content: doc, changed: false };
  const start = match.index!;
  const replacement = `${match[1]}x${match[3]}${match[4]}`;
  return {
    content: doc.slice(0, start) + replacement + doc.slice(start + match[0].length),
    changed: true,
  };
}

/**
 * Coordinator-only plan persistence. The model chooses only a T<n> id; the
 * host owns the approved path and performs an atomic compare-before-write.
 */
export function createPlanProgressTool(ops: PlanProgressOperations): AgentTool {
  const planPath = resolveWithinRoot(
    ops.planPath,
    ops.workspacePath,
    `${ops.workspacePath.replace(/[\\/]+$/, '')}/.unityide/plans`,
  );
  const planName = planPath.split('/').pop() ?? 'plan.aplan';

  return {
    name: 'plan_progress',
    label: 'complete plan todo',
    description:
      'Mark one verified todo complete in the active approved plan. Pass its exact T<n> id. ' +
      'The host preserves the rest of the plan and rejects unsaved or concurrent edits.',
    parameters: planProgressSchema,
    async execute(_toolCallId, params, signal): Promise<AgentToolResult> {
      const { todoId } = params as PlanProgressInput;
      if (signal?.aborted) return result('Plan progress update aborted.', true);
      try {
        await ops.assertAllowed?.(planPath);
      } catch (error) {
        return result(`Could not access ${planName}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      if (ops.isDirty(planPath)) {
        return result(`The open ${planName} buffer has unsaved edits. Save it before marking ${todoId.toUpperCase()} complete.`, true);
      }

      let before: string;
      try {
        before = await ops.read(planPath);
      } catch (error) {
        return result(`Could not read ${planName}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      if (signal?.aborted) return result('Plan progress update aborted.', true);
      if (ops.isDirty(planPath)) {
        return result(`The open ${planName} buffer gained unsaved edits. Save it before marking ${todoId.toUpperCase()} complete.`, true);
      }

      let update: { content: string; changed: boolean };
      try {
        update = markPlanTodoDone(before, todoId);
      } catch (error) {
        return result(error instanceof Error ? error.message : String(error), true);
      }
      const normalizedId = todoId.toUpperCase();
      if (!update.changed) return result(`${normalizedId} is already complete in ${planName}.`);

      try {
        const written = await ops.writeIfUnchanged(planPath, update.content, before);
        if (!written) {
          return result(`The plan changed on disk while ${normalizedId} was being updated. Re-read the plan and retry.`, true);
        }
        await ops.onWritten?.(planPath);
      } catch (error) {
        return result(`Could not update ${planName}: ${error instanceof Error ? error.message : String(error)}`, true);
      }
      return result(`Marked ${normalizedId} complete in ${planName}.`);
    },
  };
}
