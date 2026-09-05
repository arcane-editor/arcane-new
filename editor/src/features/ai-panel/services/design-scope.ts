/**
 * The scope the design dock works inside, and the guard that enforces it.
 *
 * Design mode is deliberately narrower than agent mode: it reshapes the ONE
 * `.uxml` open on the canvas beside it. That is not a safety rail so much as
 * an honesty one — the dock's whole premise is that what you see redraw is what
 * the agent just changed, and a turn that quietly rewrote three other screens
 * breaks that promise while looking like it kept it.
 *
 * Stylesheets are the exception in both directions: the document's own sheets
 * are in scope, and so is a NEW `.uss`, because "give this a theme" is the
 * commonest thing to ask a design chat and it has nowhere else to put one.
 *
 * The target is module-level per-send state, the same shape as
 * `send-context.ts`'s prompt mode, because the tool array is rebuilt for every
 * send (`createToolsForPromptMode`) and there is exactly one live conversation.
 */

import type { AgentTool } from './vendor/types';

let target: string | null = null;

/** Set at the top of a design-mode send; cleared when any other mode sends. */
export function setDesignTarget(documentPath: string | null): void {
  target = documentPath;
}

/** The `.uxml` the live design session is scoped to, or `null` outside design mode. */
export function getDesignTarget(): string | null {
  return target;
}

/** Compare two workspace-relative paths the way the rest of this module does. */
function samePath(a: string, b: string): boolean {
  return a.replace(/^\.\//, '').toLowerCase() === b.replace(/^\.\//, '').toLowerCase();
}

/**
 * Whether a design-mode turn may write this path, and why not when it may not.
 *
 * Pure and exported so the rule is directly testable without building a tool.
 */
export function designWriteRefusal(path: string, documentPath: string | null): string | null {
  if (!documentPath) return null;
  if (!path.toLowerCase().endsWith('.uxml')) return null;
  if (samePath(path, documentPath)) return null;
  return (
    `Not writing ${path}: this design session is scoped to ${documentPath}, the document open on ` +
    'the canvas. Tell the user what you would build and that the AI panel on the right can create ' +
    'a new screen — do not work around this by editing another document.'
  );
}

/**
 * Refuse a `.uxml` write outside the design session's own document.
 *
 * Wraps the write-side tools only. Reads are untouched: understanding the rest
 * of the project is exactly how a screen ends up belonging to it.
 */
export function withDesignScope(tool: AgentTool): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const path = (params as { path?: string }).path;
      const refusal = path ? designWriteRefusal(path, target) : null;
      if (refusal) {
        return { content: [{ type: 'text', text: refusal }] };
      }
      return tool.execute(id, params, signal, onUpdate);
    },
  };
}
