import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useRecentsStore } from './stores/recents';
import { openDroppedProject, openProjectInNewWindow, routePendingOpenToProjectWindow } from './features/project';
import { listenScoped, safeUnlisten } from './utils/tauri-listener';
import { formatRelativeDate } from './utils/date';
import { Folder, FolderOpen } from 'lucide-react';
import TooltipHost from './components/TooltipHost';

const ERROR_DISMISS_MS = 6000;

function WelcomeApp() {
  const recents = useRecentsStore((s) => s.recents);
  const reload = useRecentsStore((s) => s.reload);
  const remove = useRecentsStore((s) => s.remove);
  const [busy, setBusy] = useState(false);
  // Transient inline error (this window mounts no NotificationContainer, so
  // toasts would be invisible here). Cleared on the next action or after a
  // few seconds.
  const [error, setError] = useState<string | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  function clearError() {
    if (errorTimer.current) {
      clearTimeout(errorTimer.current);
      errorTimer.current = null;
    }
    setError(null);
  }

  function showError(message: string) {
    if (errorTimer.current) clearTimeout(errorTimer.current);
    setError(message);
    errorTimer.current = setTimeout(() => {
      errorTimer.current = null;
      setError(null);
    }, ERROR_DISMISS_MS);
  }

  useEffect(() => () => {
    if (errorTimer.current) clearTimeout(errorTimer.current);
  }, []);

  useEffect(() => { void reload(); }, [reload]);

  // Unity launches us as `UnityIDE --goto <file>:<line>:<col> <project>` or
  // `UnityIDE --project <project>`. When no window has that project open, this
  // one routes it: open the project window, which then claims the request
  // itself on boot. Also re-checked on `unityide-open-pending`, which the
  // single-instance handler emits when an already-running app is launched again
  // by Unity.
  //
  // This window is declared `"visible": false` so a launch from Unity does not
  // flash a 720x480 panel on its way to the project window. Rust shows it for
  // every launch that carried no project. When it IS hidden it is only here to
  // route, so it closes itself once it has — and shows itself instead if it
  // could not, because then it is the only surface the user has left.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    const route = async () => {
      // Were we brought into being purely to route? A hidden welcome window is
      // one nobody asked to see. Checked BEFORE routing, because routing is
      // what makes it redundant.
      let wasHidden = false;
      try {
        wasHidden = !(await getCurrentWindow().isVisible());
      } catch { /* treat as visible: never close a window we are unsure about */ }

      if (await routePendingOpenToProjectWindow()) {
        // Routed. Close rather than linger hidden: an invisible window still
        // counts as a window, so on Windows and Linux it would keep the process
        // alive after the user closes the project window, with nothing on
        // screen and no way back to it.
        if (wasHidden) {
          try {
            await getCurrentWindow().close();
          } catch { /* ignore */ }
        }
        return;
      }

      // Nothing to route, or routing failed (a moved project, a window that
      // failed to spawn). Either way this window is the only surface left.
      if (wasHidden) {
        try {
          await getCurrentWindow().show();
        } catch { /* ignore */ }
      }
    };
    void route();
    (async () => {
      const fn = await listenScoped('unityide-open-pending', () => {
        void route();
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      if (unlisten) safeUnlisten(unlisten);
    };
  }, []);

  // The manager window stays open after spawning a project window (it's not
  // tied to any single project), so recents can go stale on disk — another
  // window can open/remove a project while this one keeps showing the old
  // list. Re-read from the shared store whenever the window regains focus.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await getCurrentWindow().onFocusChanged(({ payload: focused }) => {
        if (focused) void reload();
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, [reload]);

  // Keep a stable ref to the latest `pickFolder` closure so the
  // `menu-action` listener below (registered once, on mount) always invokes
  // the current one — not a stale closure from the render it subscribed in.
  const pickFolderRef = useRef<() => void>(() => {});
  const openDroppedProjectRef = useRef<(paths: string[]) => void>(() => {});

  // Native menu (macOS): `menu-action` is routed to the FOCUSED window. Now
  // that the welcome window stays open after spawning a project window,
  // Cmd+O / Cmd+Shift+N focused HERE would otherwise be silent no-ops — this
  // window (unlike App.tsx's) has no command registry to bridge
  // `menu-action` into.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await listenScoped<string>('menu-action', (event) => {
        if (event.payload === 'file.openFolder') {
          pickFolderRef.current();
        }
        // 'file.newWindow': no-op — the welcome window IS the new-window
        // surface and is already open/focused. All other ids: ignored.
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  async function pickFolder() {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      const sel = await open({ directory: true, multiple: false, title: 'Open Folder' });
      if (typeof sel === 'string') {
        await openProjectInNewWindow(sel);
      }
    } catch (err) {
      // Rare (the folder was just picked), but possible: deleted between
      // pick and open, or the window itself failed to spawn.
      const msg = err instanceof Error ? err.message : String(err);
      showError(`Couldn't open the folder — it may have been moved or deleted. (${msg})`);
    } finally {
      setBusy(false);
    }
  }
  pickFolderRef.current = pickFolder;

  async function handleProjectDrop(paths: string[]) {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      const opened = await openDroppedProject(paths);
      if (!opened) showError('Drop exactly one folder to open it.');
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      showError(`Couldn't open the dropped folder - it may have been moved or deleted. (${msg})`);
    } finally {
      setBusy(false);
    }
  }
  openDroppedProjectRef.current = handleProjectDrop;

  // Tauri intercepts Finder/Explorer drops natively, so this window cannot
  // observe HTML5 drop events. Keep this listener in the manager only; project
  // windows retain their existing file, terminal, AI, and Explorer drop routes.
  useEffect(() => {
    let unlisten: (() => void) | null = null;
    let cancelled = false;
    (async () => {
      const fn = await getCurrentWindow().onDragDropEvent((event) => {
        if (event.payload.type === 'drop') {
          void openDroppedProjectRef.current(event.payload.paths);
        }
      });
      if (cancelled) safeUnlisten(fn);
      else unlisten = fn;
    })();
    return () => {
      cancelled = true;
      safeUnlisten(unlisten);
    };
  }, []);

  async function pickRecent(path: string) {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      await openProjectInNewWindow(path);
    } catch (err) {
      // Only drop the recent entry when the project itself is confirmed
      // gone (tagged by `openProjectInNewWindow`'s `dir_exists` guard) —
      // not for a rare window-spawn failure on an otherwise-valid path.
      const missing = err instanceof Error && err.name === 'ProjectMissingError';
      if (missing) {
        remove(path);
        showError(`Couldn't open ${path} — it may have been moved or deleted. Removed from recent projects.`);
      } else {
        const msg = err instanceof Error ? err.message : String(err);
        showError(`Couldn't open ${path}. (${msg})`);
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{
      display: 'flex',
      flexDirection: 'column',
      height: '100vh',
      background: 'var(--bg-primary)',
      color: 'var(--text-primary)',
      fontFamily: 'var(--font-display)',
    }}>
      <TooltipHost />
      <div data-tauri-drag-region style={{ height: 28, flexShrink: 0 }} />
      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 36px 32px',
      }}>
        <div style={{ marginBottom: 28, paddingLeft: 80 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: 2 }}>UNITYIDE</h1>
          <div style={{ marginTop: 4, fontSize: 13, color: 'var(--text-secondary)' }}>
            AI-assisted editor for Unity
          </div>
        </div>

      <div style={{ display: 'flex', gap: 10, marginBottom: 24 }}>
        <button onClick={pickFolder} disabled={busy} style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          padding: '8px 16px', background: 'var(--accent)', color: 'var(--bg-primary)',
          border: 'none', borderRadius: 6, cursor: 'pointer', fontSize: 13, fontWeight: 600,
        }}>
          <FolderOpen size={14} /> Open Folder
        </button>
      </div>

      <div style={{
        flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column',
        border: '1px solid var(--border)', borderRadius: 6, overflow: 'hidden',
      }}>
        <div style={{
          padding: '8px 14px', borderBottom: '1px solid var(--border)',
          fontSize: 11, color: 'var(--text-secondary)', letterSpacing: 1, textTransform: 'uppercase',
        }}>
          Recent Projects
        </div>
        {error && (
          <div style={{
            padding: '8px 14px', fontSize: 12, lineHeight: 1.4,
            color: 'var(--error-text, #dc2626)',
            borderBottom: '1px solid var(--border)',
            overflowWrap: 'break-word',
          }}>
            {error}
          </div>
        )}
        <div style={{ flex: 1, overflowY: 'auto' }}>
          {recents.length === 0 ? (
            <div style={{ padding: '20px 14px', color: 'var(--text-secondary)', fontSize: 13 }}>
              No recent projects yet.
            </div>
          ) : recents.map((r) => (
            <div key={r.path} onClick={() => pickRecent(r.path)} style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '10px 14px', cursor: busy ? 'wait' : 'pointer',
              borderBottom: '1px solid var(--border)',
            }}>
              <Folder size={14} style={{ color: 'var(--text-secondary)', flexShrink: 0 }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 13, color: 'var(--text-primary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.name}
                </div>
                <div style={{ fontSize: 11, color: 'var(--text-secondary)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {r.path}
                </div>
              </div>
              <div style={{ fontSize: 11, color: 'var(--text-secondary)' }}>
                {formatRelativeDate(new Date(r.lastOpened).toISOString())}
              </div>
            </div>
          ))}
        </div>
      </div>
      </div>
    </div>
  );
}

export default WelcomeApp;
