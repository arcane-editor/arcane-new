import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { useUnityStore } from '../../../stores/unity';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useSettingsStore } from '../../../stores/settings';
import { useCommandsStore } from '../../../stores/commands';
import { formatKeybinding } from '../../../utils/format-keybinding';
import { COACH_MARKS, markSeen, shouldShow } from '../services/coach-marks';

const SESSION_START = Date.now();

/**
 * Renders at most one contextual hint, when a capability first becomes
 * relevant.
 *
 * Every trigger below is an EVENT, not a timer or a page visit: Unity
 * connecting, a C# file being opened, a compile failing. A hint that fires
 * because time passed is an interruption; one that fires because the user just
 * did the thing it relates to is an answer.
 */
function CoachMarks() {
  const [activeId, setActiveId] = useState<string | null>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const enabled = useSettingsStore((s) => s.getSetting('ui.coachMarks.enabled') !== false);
  const unityConnected = useUnityStore((s) => s.connected);
  const lastCompilation = useUnityStore((s) => s.lastCompilation);
  const activeFilePath = useWorkspaceStore((s) => s.activeFilePath);

  // One at a time: a second trigger while one is up is dropped, not queued.
  // A queue would mean dismissing a hint summons another, which is nagging.
  const showingRef = useRef(false);
  showingRef.current = activeId !== null;

  function tryShow(id: string) {
    if (showingRef.current) return;
    if (!shouldShow(id, enabled, Date.now() - SESSION_START)) return;
    const el = document.querySelector(COACH_MARKS[id].anchor);
    // No anchor on screen means the thing being pointed at is not visible;
    // showing the hint anyway would point at nothing.
    if (!el) return;
    setRect(el.getBoundingClientRect());
    setActiveId(id);
    markSeen(id);
  }

  useEffect(() => {
    if (unityConnected) tryShow('unityConnected');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [unityConnected]);

  useEffect(() => {
    if (activeFilePath?.toLowerCase().endsWith('.cs')) tryShow('firstCsharpFile');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeFilePath]);

  useEffect(() => {
    // `errors` is a COUNT, not a list.
    if (lastCompilation && (lastCompilation.errors ?? 0) > 0) tryShow('firstCompileError');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lastCompilation]);

  // Any layout change invalidates the measured position, and a hint pointing
  // at the wrong place is worse than none.
  useEffect(() => {
    if (!activeId) return;
    const dismiss = () => setActiveId(null);
    const t = setTimeout(dismiss, 9000);
    window.addEventListener('resize', dismiss);
    window.addEventListener('scroll', dismiss, true);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') dismiss();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('keydown', onKey);
    };
  }, [activeId]);

  const chordFor = useCommandsStore((s) => s.commands);
  if (!activeId || !rect) return null;

  const mark = COACH_MARKS[activeId];
  const kb = mark.commandId ? chordFor.get(mark.commandId)?.keybinding : undefined;

  return createPortal(
    <div
      className="coach-mark"
      role="status"
      style={{ top: rect.top + rect.height / 2, left: rect.right + 12 }}
    >
      <span className="coach-mark-text">{mark.message}</span>
      {kb && <kbd className="coach-mark-chord">{formatKeybinding(kb)}</kbd>}
      <button
        type="button"
        className="coach-mark-close"
        aria-label="Dismiss"
        onClick={() => setActiveId(null)}
      >
        <X size={11} />
      </button>
    </div>,
    document.body,
  );
}

export default CoachMarks;
