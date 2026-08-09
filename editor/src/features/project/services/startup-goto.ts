import { invoke } from '@tauri-apps/api/core';
import { useWorkspaceStore } from '../../../stores/workspace';
import { setPendingNavigation } from '../../../utils/editor-navigation';
import { openProjectInNewWindow } from './multi-window';

/**
 * A `--goto` Unity passed on the command line, collected from the Rust side.
 *
 * Unity launches the configured external script editor as
 * `Arcane.exe --goto "<file>:<line>:<col>" "<projectPath>"`. Nothing read argv,
 * so double-clicking a script in Unity's Project window opened the 720x480
 * Welcome window instead of the file — the core Unity-to-IDE workflow, broken
 * on every platform.
 */
export interface GotoTarget {
  file: string;
  line: number;
  column: number;
  project: string | null;
}

/** Paths arrive `/`-separated from Rust (`path_util.rs`); normalise anyway. */
function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
}

/**
 * Claim a pending `--goto` for this project window and open the file.
 *
 * The claim is conditional on the Rust side: a target carrying a different
 * project is left pending for the window that owns it, so several windows can
 * boot concurrently without any of them swallowing another's target.
 *
 * Returns true when a target was claimed and opened.
 */
export async function consumePendingGotoForWorkspace(workspacePath: string | null): Promise<boolean> {
  let target: GotoTarget | null = null;
  try {
    target = await invoke<GotoTarget | null>('claim_pending_goto', { workspacePath });
  } catch {
    return false;
  }
  if (!target) return false;

  // Set the navigation before opening: EditorPanel consumes it on the
  // activeFilePath effect, which fires as a result of openFile.
  setPendingNavigation({ line: target.line, column: target.column });
  try {
    await useWorkspaceStore.getState().openFile(target.file, basename(target.file));
  } catch {
    return false;
  }
  return true;
}

/**
 * Welcome-window half: if a `--goto` is waiting for a project no window has
 * open, open that project. The window that boots then claims the target
 * itself via `consumePendingGotoForWorkspace`.
 *
 * Peeks rather than claims — consuming here would strand the target in a
 * window that cannot act on it.
 */
export async function routePendingGotoToProjectWindow(): Promise<boolean> {
  let target: GotoTarget | null = null;
  try {
    target = await invoke<GotoTarget | null>('peek_pending_goto');
  } catch {
    return false;
  }
  if (!target?.project) return false;

  await openProjectInNewWindow(target.project);
  return true;
}
