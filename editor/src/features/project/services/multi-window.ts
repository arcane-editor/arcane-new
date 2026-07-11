import { WebviewWindow, getAllWebviewWindows, getCurrentWebviewWindow } from '@tauri-apps/api/webviewWindow';
import { open } from '@tauri-apps/plugin-dialog';
import { invoke } from '@tauri-apps/api/core';

const HASH_PREFIX = 'editor-';

function basename(p: string): string {
  return p.split('/').filter(Boolean).pop() ?? p;
}

function hashLabel(path: string): string {
  let h = 5381 >>> 0;
  for (let i = 0; i < path.length; i++) h = ((h * 33) ^ path.charCodeAt(i)) >>> 0;
  return HASH_PREFIX + h.toString(16).padStart(8, '0');
}

async function findWindowByLabel(label: string): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return all.find((w) => w.label === label) ?? null;
}

export async function openProjectInNewWindow(path: string): Promise<void> {
  if (!path) return;
  const ok = await invoke<boolean>('dir_exists', { path });
  if (!ok) throw new Error('Project folder not found: ' + path);
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
