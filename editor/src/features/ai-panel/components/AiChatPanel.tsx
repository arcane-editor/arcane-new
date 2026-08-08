/**
 * AiChatPanel — top-level container for the AI chat sidebar.
 * Composes the header (agent picker + new-chat button), message list,
 * input area, and error banner.
 */

import { useState, useEffect } from 'react';
import { RotateCcw, History, Paperclip } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { useWorkspaceStore } from '../../../stores/workspace';
import { ARCANE_FILE_MIME, parseFileDrag } from '../../../utils/drag-mime';
import { resetAgentService } from '../services/agent-service';
import { buildFileAttachment, isAlreadyStaged } from '../services/stage-file';
import MessageList from './MessageList';
import ReviewBar from './ReviewBar';
import PlanList from './PlanList';
import ChatInput from './ChatInput';
import AiSignInGate from './AiSignInGate';
import AiVerifyEmailGate from './AiVerifyEmailGate';
import AgentPicker from './AgentPicker';
import SessionHistory from './SessionHistory';

function AiChatPanel() {
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const resetConversation = useAiStore((s) => s.resetConversation);
  const errorMessage = useAiStore((s) => s.errorMessage);
  const setError = useAiStore((s) => s.setError);
  const authNotice = useAiStore((s) => s.authNotice);
  const setAuthNotice = useAiStore((s) => s.setAuthNotice);
  const verificationRequired = useAiStore((s) => s.verificationRequired);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  // T5: the notice explaining WHY the user was signed out (arcane-stream's
  // 401/403 path) should disappear once they've actually logged back in,
  // rather than lingering into the next signed-in session.
  useEffect(() => {
    if (loggedIn) setAuthNotice(null);
  }, [loggedIn, setAuthNotice]);

  if (!loggedIn) {
    return (
      <div className="ai-panel">
        <div className="ai-panel-header">
          <AgentPicker />
        </div>
        {authNotice && (
          <div className="ai-panel-error">
            <span>{authNotice}</span>
            <button onClick={() => setAuthNotice(null)}>x</button>
          </div>
        )}
        <AiSignInGate />
      </div>
    );
  }

  // Signed in, but the mailbox isn't confirmed and the server is refusing AI
  // calls with 403 email_unverified. Checked AFTER the !loggedIn branch so a
  // stale flag can never mask the sign-in gate.
  if (verificationRequired) {
    return <AiVerifyEmailGate />;
  }

  function handleNewChat() {
    resetConversation();
    resetAgentService();
  }

  // Files dragged in from the explorer tree or the tab bar. These are
  // in-webview HTML5 drags, unaffected by Tauri's native interception of OS
  // file drops — those still open as editor tabs via App.tsx.
  function handleDragOver(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes(ARCANE_FILE_MIME)) return;
    // Without preventDefault the browser refuses the drop outright.
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
    if (!dragOver) setDragOver(true);
  }

  function handleDragLeave(e: React.DragEvent) {
    // dragleave also fires when crossing between children, which would flicker
    // the overlay; only a leave that exits the panel entirely counts.
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragOver(false);
  }

  function handleDrop(e: React.DragEvent) {
    setDragOver(false);
    const payload = parseFileDrag(e.dataTransfer.getData(ARCANE_FILE_MIME));
    if (!payload) return;
    e.preventDefault();

    if (payload.isDir) {
      setError('Folders cannot be attached as context — drop a file instead.');
      return;
    }

    const { attachments, addAttachment } = useAiStore.getState();
    // Re-dropping a staged file is a no-op rather than a duplicate chip.
    if (isAlreadyStaged(attachments, payload.path)) return;

    const workspacePath = useWorkspaceStore.getState().workspacePath;
    addAttachment(buildFileAttachment(payload.path, workspacePath));
  }

  return (
    <div
      className={`ai-panel${dragOver ? ' ai-panel--drop-over' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      {/* Header */}
      <div className="ai-panel-header">
        <AgentPicker />
        <div className="ai-panel-header-actions">
          <button
            className="ai-panel-header-btn"
            onClick={() => setHistoryOpen((v) => !v)}
            title="Chat history"
          >
            <History size={12} />
            <span>History</span>
          </button>
          <button
            className="ai-panel-new-chat"
            onClick={handleNewChat}
            title="New Chat"
          >
            <RotateCcw size={12} />
            <span>New Chat</span>
          </button>
          <SessionHistory open={historyOpen} onClose={() => setHistoryOpen(false)} />
        </div>
      </div>

      {/* Error banner */}
      {errorMessage && (
        <div className="ai-panel-error">
          <span>{errorMessage}</span>
          <button onClick={() => setError(null)}>x</button>
        </div>
      )}

      {/* Messages */}
      <MessageList />

      {/* T8: Cursor-style Accept/Reject bar for pending auto-applied edits
          (hidden when nothing is pending). */}
      <ReviewBar />

      {/* T9: sticky, collapsible in-loop todo list (todo_update tool) — lives
          for the whole session (not just the current turn), so it sits
          closer to the composer than the transient ReviewBar above. Hidden
          entirely when there's no plan yet (see PlanList). */}
      <PlanList />

      {/* Input */}
      <ChatInput />

      {/* Drop affordance. `pointer-events: none` in CSS is load-bearing: the
          overlay sits above the panel, and intercepting the pointer would
          swallow the very drop it is advertising. */}
      {dragOver && (
        <div className="ai-panel-drop-overlay">
          <div className="ai-panel-drop-overlay-label">
            <Paperclip size={14} />
            <span>Drop to add as context</span>
          </div>
        </div>
      )}
    </div>
  );
}

export default AiChatPanel;
