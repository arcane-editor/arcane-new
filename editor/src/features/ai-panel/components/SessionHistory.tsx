/**
 * SessionHistory — a dropdown list of past chat sessions for the current
 * workspace. Opening a session loads its transcript and resumes it by replaying
 * history into the Arcane agent. Supports delete + rename. Older sessions saved
 * under a now-removed agent kind restore read-only as Arcane (agentKind is
 * coerced on load — see session-persistence).
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Trash2, Pencil, X, Check, FileText } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useWorkspaceStore } from '../../../stores/workspace';
import {
  listSessions,
  loadSession,
  deleteSession,
  renameSession,
  type SessionSummary,
} from '../services/session-persistence';
import { getAgentService } from '../services/agent-service';

interface Props {
  open: boolean;
  onClose: () => void;
}

function relativeTime(ts: number): string {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr}h ago`;
  const day = Math.floor(hr / 24);
  if (day < 7) return `${day}d ago`;
  return new Date(ts).toLocaleDateString();
}

function SessionHistory({ open, onClose }: Props) {
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const loadSessionIntoStore = useAiStore((s) => s.loadSessionIntoStore);
  // Drives the disabled affordance on each row's open trigger below — kept in
  // sync with the guard inside `openSession` itself (belt-and-suspenders: the
  // guard is what actually prevents the hang if this render is stale).
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  // Needed to notice a delete of the session that is currently OPEN.
  const activeSessionId = useAiStore((s) => s.sessionId);
  const [sessions, setSessions] = useState<SessionSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    listSessions(workspacePath)
      .then(setSessions)
      .catch(() => setSessions([]))
      .finally(() => setLoading(false));
  }, [workspacePath]);

  useEffect(() => {
    if (open) refresh();
  }, [open, refresh]);

  // Click outside closes.
  useEffect(() => {
    if (!open) return;
    function onClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) onClose();
    }
    const t = setTimeout(() => window.addEventListener('mousedown', onClick), 0);
    return () => {
      clearTimeout(t);
      window.removeEventListener('mousedown', onClick);
    };
  }, [open, onClose]);

  const openSession = useCallback(
    async (summary: SessionSummary) => {
      // Guard consistently with session-restore.ts's restoreLatestSessionForWorkspace:
      // resume()/loadSessionIntoStore() on a RUNNING agent (e.g. mid tool call, or
      // blocked for minutes on a pending ask_user question) stomps the live session
      // out from under it, so the in-flight gate promise never resolves and the
      // agent is stuck "already processing" until New Chat.
      if (useAiStore.getState().isAgentRunning) return;
      const data = await loadSession(summary.id);
      if (!data) return;
      loadSessionIntoStore(data);
      getAgentService().resume(data.messages);
      onClose();
    },
    [loadSessionIntoStore, onClose],
  );

  /**
   * Deleting the session that is currently OPEN has to start a new chat.
   * `deleteSession` co-deletes the checkpoint and review files, but the live
   * stores keep their in-memory copies and their `sessionId` — so the next
   * autosave recreated the session file and the next `recordPreWrite` rewrote
   * the checkpoints, leaving the delete half-applied and "Restore this turn"
   * pointing at pre-images the user had just thrown away.
   */
  const handleDelete = useCallback(
    async (sessionId: string) => {
      await deleteSession(sessionId);
      if (sessionId === activeSessionId) {
        window.dispatchEvent(new CustomEvent('ai-new-chat'));
      }
      await refresh();
    },
    [activeSessionId, refresh],
  );

  if (!open) return null;

  return (
    <div className="ai-history-dropdown" ref={ref}>
      <div className="ai-history-header">
        <span>Chat History</span>
        <button className="ai-history-close" onClick={onClose} title="Close">
          <X size={13} />
        </button>
      </div>
      <div className="ai-history-list">
        {loading ? (
          <div className="ai-history-empty">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="ai-history-empty">No past chats in this workspace.</div>
        ) : (
          sessions.map((s) => (
            <div key={s.id} className="ai-history-item">
              <span className="ai-history-icon">
                <Sparkles size={13} />
              </span>
              {editingId === s.id ? (
                <input
                  className="ai-history-rename-input"
                  value={editText}
                  autoFocus
                  onChange={(e) => setEditText(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      void renameSession(s.id, editText.trim() || s.title).then(refresh);
                      setEditingId(null);
                    } else if (e.key === 'Escape') {
                      setEditingId(null);
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                />
              ) : (
                <button
                  className="ai-history-title"
                  onClick={() => openSession(s)}
                  disabled={isAgentRunning}
                  title={isAgentRunning ? 'Stop the running agent before switching chats' : s.title}
                >
                  <span className="ai-history-title-text">{s.title}</span>
                  <span className="ai-history-meta">
                    {s.messageCount} msg · {relativeTime(s.updatedAt)}
                    {/* A plan is an artifact of the session that produced it,
                        so the row that reopens the conversation also says a
                        plan came out of it. */}
                    {s.planCount > 0 && (
                      <>
                        {' · '}
                        <span className="ai-session-plan-chip">
                          <FileText size={10} />
                          {s.planCount} plan{s.planCount === 1 ? '' : 's'}
                        </span>
                      </>
                    )}
                  </span>
                </button>
              )}
              <div className="ai-history-actions">
                {editingId === s.id ? (
                  <button
                    className="ai-history-action"
                    title="Save"
                    onClick={() => {
                      void renameSession(s.id, editText.trim() || s.title).then(refresh);
                      setEditingId(null);
                    }}
                  >
                    <Check size={12} />
                  </button>
                ) : (
                  <button
                    className="ai-history-action"
                    title="Rename"
                    onClick={() => {
                      setEditingId(s.id);
                      setEditText(s.title);
                    }}
                  >
                    <Pencil size={12} />
                  </button>
                )}
                <button
                  className="ai-history-action"
                  title="Delete"
                  onClick={() => void handleDelete(s.id)}
                >
                  <Trash2 size={12} />
                </button>
              </div>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default SessionHistory;
