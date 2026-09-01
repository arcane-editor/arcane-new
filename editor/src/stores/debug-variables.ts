/**
 * Pure helpers for the debugger's variable tree.
 *
 * A LEAF module by design: `stores/debug.ts` transitively imports the theme
 * store, which touches `document` at module-eval time and therefore cannot be
 * imported from a bun test. Keeping the logic that is worth testing out here
 * is the same split `diagnostics.ts` and `terminal-groups.ts` make.
 */

export interface VariableNode {
  name: string;
  value: string;
  type?: string;
  /** >0 means expandable — it addresses this row's CHILDREN, not this row. */
  variablesReference: number;
}

/**
 * Apply a DAP `setVariable` response to the cached rows.
 *
 * Two details matter: the adapter's echoed value is authoritative (the runtime
 * may parse `1/2` into `0`, and showing what was typed would be a lie), and a
 * container that is not cached is left untouched rather than created.
 */
export function applySetVariable(
  variables: Map<number, VariableNode[]>,
  containerRef: number,
  name: string,
  res: { value: string; type?: string; variablesReference?: number },
): Map<number, VariableNode[]> {
  const rows = variables.get(containerRef);
  if (!rows) return variables;
  const next = new Map(variables);
  next.set(
    containerRef,
    rows.map((r) =>
      r.name === name
        ? {
            ...r,
            value: res.value,
            type: res.type ?? r.type,
            variablesReference: res.variablesReference ?? r.variablesReference,
          }
        : r,
    ),
  );
  return next;
}
