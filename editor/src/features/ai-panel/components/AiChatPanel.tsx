/**
 * AiChatPanel — top-level container for the AI chat sidebar.
 * Composes the header (agent picker + new-chat button), message list,
 * input area, and error banner.
 */

import { useState, useEffect } from 'react';
import { RotateCcw, History } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { resetAgentService } from '../services/agent-service';
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

  return (
    <div className="ai-panel">
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
    </div>
  );
}

export default AiChatPanel;
