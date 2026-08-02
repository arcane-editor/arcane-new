import { WebviewWindow, getAllWebviewWindows, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';
import { hashLabel } from '../../../utils/window-label';

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

async function findWindowByLabel(label: string): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((w) => w.label === label) ?? null;
}

export async function openProjectInNewWindow(rawPath: string): Promise<void> {
  if (!rawPath) return;
  // Canonicalize FIRST: `unity_ipc::hash_workspace` (Rust) canonicalizes the
  // workspace path before hashing it into the Unity IPC socket/pipe path. If
  // this window's label were hashed from the raw path instead, the same
  // project opened via two different spellings (a symlink, a trailing
  // slash, `..` segments) would get two different window labels while
  // colliding on the SAME canonical Unity IPC socket — the second window's
  // cleanup could then unlink the first window's still-live socket. Doing
  // this once up front keeps the label, window dedup, `?path=` param, and
  // recents all on one canonical form.
  const path = await invoke<string>('canonicalize_path', { path: rawPath });
  const ok = await invoke<boolean>('dir_exists', { path });
  if (!ok) {
    // Tagged so callers (WelcomeApp/WelcomeScreen) can tell "the project is
    // actually gone" apart from a rare window-spawn failure below on an
    // otherwise-valid path — only the former should drop the recent entry.
    const err = new Error('Project folder not found: ' + path);
    err.name = 'ProjectMissingError';
    throw err;
  }
  const label = hashLabel(path);
  const existing = await findWindowByLabel(label);
  if (existing) {
    try {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
    } catch { /* ignore */ }
    return;
  }

  const url = `/index.html?view=editor&path=${encodeURIComponent(path)}`;
  const wnd = new WebviewWindow(label, {
    url,
    title: `${basename(path)} — Arcane`,
    width: 1200,
    height: 800,
    minWidth: 800,
    minHeight: 600,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
    backgroundColor: '#13121A',
  });
  await new Promise<void>((resolve, reject) => {
    wnd.once('tauri://created', () => resolve());
    wnd.once('tauri://error', (e) => reject(e));
  });
}

export async function openFolderInNewWindow(): Promise<void> {
  const sel = await open({ directory: true, multiple: false, title: 'Open Folder' });
  if (typeof sel === 'string') await openProjectInNewWindow(sel);
}

export async function openWelcomeWindow(): Promise<void> {
  const existing = await findWindowByLabel('welcome');
  if (existing) {
    try {
      await existing.unminimize();
      await existing.show();
      await existing.setFocus();
    } catch { /* ignore */ }
    return;
  }
  const wnd = new WebviewWindow('welcome', {
    url: '/index.html?view=welcome',
    title: 'Arcane',
    width: 720,
    height: 480,
    minWidth: 600,
    minHeight: 360,
    resizable: true,
    titleBarStyle: 'overlay',
    hiddenTitle: true,
    backgroundColor: '#13121A',
  });
  await new Promise<void>((resolve, reject) => {
    wnd.once('tauri://created', () => resolve());
    wnd.once('tauri://error', (e) => reject(e));
  });
}

export async function setProjectWindowTitle(path: string | null): Promise<void> {
  try {
    const w = getCurrentWebviewWindow();
    if (path) await w.setTitle(`${basename(path)} — Arcane`);
    else await w.setTitle('Arcane');
  } catch { /* ignore */ }
}
