import { useEffect, useState } from 'react';
import { Minus, Square, Copy, X } from 'lucide-react';
import { getCurrentWindow } from '@tauri-apps/api/window';

/**
 * Minimize / maximize / close, for the platforms that do not draw their own.
 *
 * macOS overlays its traffic lights on top of our title bar
 * (`titleBarStyle: "Overlay"`), so it needs none of this. Windows and Linux
 * have no such option: leaving `decorations` on gave them the OS title bar
 * *plus* ours, stacked. Turning decorations off removes the duplicate, which
 * means we owe them these buttons.
 *
 * Renders nothing on macOS — the caller gates on `data-os`, and this guard is
 * the belt to that's braces.
 */
function WindowControls() {
  const [maximized, setMaximized] = useState(false);

  useEffect(() => {
    const win = getCurrentWindow();
    let unlisten: (() => void) | null = null;
    let cancelled = false;

    void win.isMaximized().then((m) => {
      if (!cancelled) setMaximized(m);
    });

    // The window can also be maximized by double-clicking the drag region or
    // by a keyboard shortcut, so the icon has to follow the window, not our
    // own button presses.
    void win.onResized(() => {
      void win.isMaximized().then((m) => {
        if (!cancelled) setMaximized(m);
      });
    }).then((fn) => {
      if (cancelled) fn();
      else unlisten = fn;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, []);

  const win = getCurrentWindow();

  return (
    <div className="window-controls">
      <button
        className="window-control"
        aria-label="Minimize"
        title="Minimize"
        onClick={() => void win.minimize()}
      >
        <Minus size={14} aria-hidden="true" />
      </button>
      <button
        className="window-control"
        aria-label={maximized ? 'Restore' : 'Maximize'}
        title={maximized ? 'Restore' : 'Maximize'}
        onClick={() => void win.toggleMaximize()}
      >
        {maximized ? <Copy size={12} aria-hidden="true" /> : <Square size={12} aria-hidden="true" />}
      </button>
      <button
        className="window-control window-control--close"
        aria-label="Close"
        title="Close"
        onClick={() => void win.close()}
      >
        <X size={15} aria-hidden="true" />
      </button>
    </div>
  );
}

export default WindowControls;
