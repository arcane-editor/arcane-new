/**
 * SessionHistory — a dropdown list of past chat sessions for the current
 * workspace (both Arcane + Claude). Opening a session loads its transcript and
 * resumes it: Arcane replays history into the agent; Claude re-attaches via ACP
 * session/load. Supports delete + rename.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { Sparkles, Bot, Trash2, Pencil, X, Check } from 'lucide-react';
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
import { getClaudeAgentService } from '../services/claude-agent-service';

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
      const data = await loadSession(summary.id);
      if (!data) return;
      loadSessionIntoStore(data);
      if (data.agentKind === 'claude') {
        if (data.acpSessionId) void getClaudeAgentService().resumeSession(data.acpSessionId);
      } else {
        getAgentService().resume(data.messages);
      }
      onClose();
    },
    [loadSessionIntoStore, onClose],
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
                {s.agentKind === 'claude' ? <Bot size={13} /> : <Sparkles size={13} />}
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
                />
              ) : (
                <button className="ai-history-title" onClick={() => openSession(s)} title={s.title}>
                  <span className="ai-history-title-text">{s.title}</span>
                  <span className="ai-history-meta">
                    {s.messageCount} msg · {relativeTime(s.updatedAt)}
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
                  onClick={() => void deleteSession(s.id).then(refresh)}
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
