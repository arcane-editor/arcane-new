import { useCallback, useEffect, useRef, useState } from 'react';
import type { SessionSummary } from '../../ai-panel';
import { formatRelativeDate } from '../../../utils/date';
import { listDesignThreads } from '../services/design-session';

interface Props {
  documentPath: string;
  documentName: string;
  /** The live thread, so the list can say which one you are already in. */
  activeId: string | null;
  onOpen: (id: string) => void;
  onClose: () => void;
}

/**
 * The design threads this screen has had.
 *
 * Scoped to one document, which is not a simplification — the dock is bound to
 * the screen behind it and `withDesignScope` refuses a `.uxml` write to any
 * other, so offering HUD.uxml's thread here would drop the agent into a
 * conversation about a screen the canvas is not showing and whose first write
 * would be refused. The AI panel's own history is the place to reach everything.
 *
 * Reads the same session store the panel's history does; there is one
 * conversation and these are two views onto its past.
 */
export function DesignHistory({ documentPath, documentName, activeId, onOpen, onClose }: Props) {
  const [threads, setThreads] = useState<SessionSummary[] | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let live = true;
    listDesignThreads(documentPath)
      .then((rows) => {
        if (live) setThreads(rows);
      })
      .catch(() => {
        if (live) setThreads([]);
      });
    return () => {
      live = false;
    };
  }, [documentPath]);

  // Click outside and Escape both close, the same two gestures the panel's
  // history popover answers to.
  useEffect(() => {
    function onPointer(e: PointerEvent) {
      if (!ref.current?.contains(e.target as Node)) onClose();
    }
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [onClose]);

  const stopDrag = useCallback((e: React.PointerEvent) => e.stopPropagation(), []);

  return (
    <div className="design-history" ref={ref} onPointerDown={stopDrag} role="dialog" aria-label={`Design threads for ${documentName}`}>
      {threads === null && <p className="design-history-empty">Reading past threads…</p>}

      {threads?.length === 0 && (
        <p className="design-history-empty">
          This is the first design thread for {documentName}. Start another and the one you are in
          now will be here.
        </p>
      )}

      {threads && threads.length > 0 && (
        <ul className="design-history-list">
          {threads.map((thread) => (
            <li key={thread.id}>
              <button
                type="button"
                className="design-history-row"
                data-active={thread.id === activeId ? 'yes' : 'no'}
                onClick={() => onOpen(thread.id)}
                // The one you are already in is not a destination.
                disabled={thread.id === activeId}
              >
                <span className="design-history-title">{thread.title}</span>
                <span className="design-history-meta">
                  {thread.id === activeId
                    ? 'open'
                    : formatRelativeDate(new Date(thread.updatedAt).toISOString())}
                  {' · '}
                  {thread.messageCount} {thread.messageCount === 1 ? 'message' : 'messages'}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

export default DesignHistory;
