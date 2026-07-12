/**
 * Which open tabs should live-reload after a watcher burst reported these
 * disk paths as changed. Dirty tabs never reload — unsaved edits always win
 * over external changes (VS Code semantics; the conflict surfaces on save).
 */
export function filesToReload(
  openFiles: ReadonlyArray<{ path: string; isDirty: boolean }>,
  changedPaths: readonly string[],
): string[] {
  const changed = new Set(changedPaths);
  return openFiles
    .filter(
      (f) =>
        !f.isDirty &&
        !f.path.startsWith('diff://') &&
        !f.path.startsWith('auth://') &&
        changed.has(f.path),
    )
    .map((f) => f.path);
}
