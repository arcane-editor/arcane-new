import { useEffect, useRef, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { useRecentsStore } from './stores/recents';
import { openProjectInNewWindow } from './features/project';
import { safeUnlisten } from './utils/tauri-listener';
import { formatRelativeDate } from './utils/date';
import { Folder, FolderOpen } from 'lucide-react';

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

  async function pickRecent(path: string) {
    if (busy) return;
    clearError();
    setBusy(true);
    try {
      await openProjectInNewWindow(path);
    } catch {
      remove(path);
      showError(`Couldn't open ${path} — it may have been moved or deleted. Removed from recent projects.`);
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
      fontFamily: 'var(--font-ui)',
    }}>
      <div data-tauri-drag-region style={{ height: 28, flexShrink: 0 }} />
      <div style={{
        flex: 1,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        padding: '12px 36px 32px',
      }}>
        <div style={{ marginBottom: 28, paddingLeft: 80 }}>
          <h1 style={{ margin: 0, fontSize: 22, fontWeight: 600, letterSpacing: 2 }}>ARCANE</h1>
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
