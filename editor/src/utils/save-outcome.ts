import type { OpenFile } from '../types';

/**
 * The open-file list after a write of `writtenContent` to `path` completed.
 *
 * A save is asynchronous, and the content handed to the write is captured
 * before it starts. If the user keeps typing while it runs, the buffer moves
 * on — so clearing `isDirty` unconditionally marks characters saved that were
 * never written. The file watcher then sees the on-disk change, finds the tab
 * clean, and reloads it from disk, silently discarding them.
 *
 * The tab therefore stays dirty whenever the buffer no longer matches what
 * actually reached disk. The next save writes the newer content.
 */
export function applySaveResult(
  openFiles: OpenFile[],
  path: string,
  writtenContent: string,
): OpenFile[] {
  return openFiles.map((f) =>
    f.path === path ? { ...f, isDirty: f.content !== writtenContent } : f,
  );
}
