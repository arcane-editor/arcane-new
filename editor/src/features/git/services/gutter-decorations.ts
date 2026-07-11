import type { Monaco } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

// `stores/workspace` is imported dynamically (inside `attachGitGutter` below)
// rather than statically here. A static import transitively reaches
// `stores/theme`, whose `create()` initializer touches `document` at
// module-eval time — a crash under `bun test`'s no-DOM environment. Keeping
// this file's top level free of runtime store imports means `parseDiffHunks`
// (a pure function) can be unit-tested in isolation. Same pattern as
// `features/ai-panel/services/attachments.ts`.

/**
 * Per-file changed-line ranges relative to HEAD, in NEW-file (current
 * on-disk) line numbers, 1-indexed and inclusive on both ends.
 *
 * `deletedAt` records, for each place content was removed with nothing (or
 * fewer lines than were removed) replacing it, the new-file line number the
 * gap now sits in front of — i.e. "content used to be here, right before
 * this line". A run of N consecutive removed lines collapses to a single
 * marker, matching how editors render a single gutter glyph per deletion
 * site rather than one per removed line.
 */
export interface GutterRanges {
  added: Array<[number, number]>;
  modified: Array<[number, number]>;
  deletedAt: number[];
}

const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * Pure parser for `git diff` unified-diff output into gutter ranges.
 *
 * Heuristic (per new-hunk-body "block" — a maximal run of non-context
 * lines): a run of `-` lines immediately followed by a run of `+` lines is
 * paired up to `min(dCount, aCount)`; the paired lines are "modified" (the
 * new file replaced old content with new content at the same spot). Any
 * excess `+` lines beyond the pairing are pure additions; any excess `-`
 * lines are a pure deletion, collapsed to one `deletedAt` marker. A block
 * that is pure `+` (no leading `-`) is entirely "added"; a block that is
 * pure `-` (no trailing `+`) is entirely a deletion marker.
 *
 * Diff header noise (`diff --git`, `index`, `---`/`+++`, `similarity
 * index`, `rename from/to`, `old/new mode`, etc.) is ignored — we only look
 * for `@@ ... @@` hunk headers and their bodies. `\ No newline at end of
 * file` markers are ignored too.
 */
export function parseDiffHunks(unifiedDiff: string): GutterRanges {
  const added: Array<[number, number]> = [];
  const modified: Array<[number, number]> = [];
  const deletedAt: number[] = [];

  if (!unifiedDiff) return { added, modified, deletedAt };

  const lines = unifiedDiff.split('\n');
  let i = 0;

  while (i < lines.length) {
    const header = HUNK_HEADER.exec(lines[i]);
    if (!header) {
      i++;
      continue;
    }
    let newLine = parseInt(header[1], 10);
    i++;

    while (i < lines.length && !lines[i].startsWith('@@ ')) {
      const line = lines[i];

      if (line.startsWith('\\')) {
        // "\ No newline at end of file" — not a content line.
        i++;
        continue;
      }

      if (line.startsWith('-') || line.startsWith('+')) {
        let dCount = 0;
        while (i < lines.length && lines[i].startsWith('-')) {
          dCount++;
          i++;
        }
        let aCount = 0;
        while (i < lines.length && lines[i].startsWith('+')) {
          aCount++;
          i++;
        }

        const pairCount = Math.min(dCount, aCount);
        if (pairCount > 0) {
          modified.push([newLine, newLine + pairCount - 1]);
        }
        if (aCount > pairCount) {
          added.push([newLine + pairCount, newLine + aCount - 1]);
        }
        if (dCount > pairCount) {
          deletedAt.push(newLine + pairCount);
        }
        newLine += aCount;
        continue;
      }

      // Context line (starts with ' ', or a blank line some diff output
      // renders with no trailing space) — unchanged, consumes one new line.
      newLine++;
      i++;
    }
  }

  return { added, modified, deletedAt };
}

function modelFilePath(model: MonacoEditor.ITextModel | null): string | null {
  if (!model) return null;
  const uri = model.uri.toString();
  if (!uri.startsWith('file://')) return null;
  try {
    return decodeURIComponent(uri.slice('file://'.length));
  } catch {
    return null;
  }
}

function relativeToWorkspace(absPath: string, workspacePath: string | null): string | null {
  if (!workspacePath) return null;
  if (absPath === workspacePath) return null;
  const prefix = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
  if (!absPath.startsWith(prefix)) return null;
  return absPath.slice(prefix.length);
}

/**
 * Attaches HEAD-relative changed-line gutter decorations to a Monaco editor
 * instance. The editor is reused across file/tab switches (Monaco swaps the
 * underlying model rather than remounting), so refreshes are triggered by
 * `onDidChangeModel` in addition to git-state changes and saves.
 *
 * Limitation (v1, accepted): decorations reflect DISK state vs HEAD, not the
 * live (possibly dirty) editor buffer — unsaved edits shift line numbers
 * until the file is saved and the gutter refreshes again.
 */
export function attachGitGutter(
  editor: MonacoEditor.IStandaloneCodeEditor,
  monacoNs: Monaco,
): () => void {
  const collection = editor.createDecorationsCollection();
  let generation = 0;
  let disposed = false;

  const clampLine = (line: number): number => {
    const total = editor.getModel()?.getLineCount() ?? line;
    return Math.min(Math.max(line, 1), Math.max(total, 1));
  };

  const renderRanges = (ranges: GutterRanges) => {
    const decos: MonacoEditor.IModelDeltaDecoration[] = [];
    for (const [start, end] of ranges.added) {
      decos.push({
        range: new monacoNs.Range(clampLine(start), 1, clampLine(end), 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'git-gutter-added' },
      });
    }
    for (const [start, end] of ranges.modified) {
      decos.push({
        range: new monacoNs.Range(clampLine(start), 1, clampLine(end), 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'git-gutter-modified' },
      });
    }
    for (const line of ranges.deletedAt) {
      const clamped = clampLine(line);
      decos.push({
        range: new monacoNs.Range(clamped, 1, clamped, 1),
        options: { isWholeLine: true, linesDecorationsClassName: 'git-gutter-deleted' },
      });
    }
    collection.set(decos);
  };

  const refresh = async (path: string | null) => {
    // Stale-guard: a slow diff for a previously-active file must not paint
    // over decorations for whatever file is displayed by the time it
    // resolves.
    const myGen = ++generation;
    collection.clear();

    if (!path || path.startsWith('diff://') || path.startsWith('auth://')) return;

    const { useWorkspaceStore } = await import('../../../stores/workspace');
    if (disposed || myGen !== generation) return;

    const { workspacePath } = useWorkspaceStore.getState();
    const relPath = relativeToWorkspace(path, workspacePath);
    if (!relPath) return;

    let diff: string;
    try {
      diff = await invoke<string>('git_diff_file_head', {
        workspacePath,
        filePath: relPath,
      });
    } catch {
      // Not a git repo, file not tracked in a repo we can diff, etc. — no
      // decorations, not an error worth surfacing in the gutter.
      return;
    }

    if (disposed || myGen !== generation) return;
    // Re-check the model is still the one we started diffing — the file
    // could have switched again while the invoke was in flight.
    if (modelFilePath(editor.getModel()) !== path) return;

    renderRanges(parseDiffHunks(diff));
  };

  const currentPath = () => modelFilePath(editor.getModel());

  const modelDisposable = editor.onDidChangeModel(() => {
    void refresh(currentPath());
  });

  let unlistenGitState: UnlistenFn | null = null;
  listen('git-state-changed', () => {
    void refresh(currentPath());
  }).then((fn) => {
    if (disposed) {
      fn();
      return;
    }
    unlistenGitState = fn;
  });

  // Save signal: refresh when the active file's dirty flag transitions
  // true -> false, without touching the save path itself.
  let unsubscribeSave: (() => void) | null = null;
  import('../../../stores/workspace').then(({ useWorkspaceStore }) => {
    if (disposed) return;
    unsubscribeSave = useWorkspaceStore.subscribe((state, prevState) => {
      const path = currentPath();
      if (!path) return;
      const file = state.openFiles.find((f) => f.path === path);
      const prevFile = prevState.openFiles.find((f) => f.path === path);
      if (file && !file.isDirty && prevFile?.isDirty) {
        void refresh(path);
      }
    });
  });

  void refresh(currentPath());

  return () => {
    disposed = true;
    modelDisposable.dispose();
    unlistenGitState?.();
    unsubscribeSave?.();
    collection.clear();
  };
}
