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
import ChatInput from './ChatInput';
import AiSignInGate from './AiSignInGate';
import AgentPicker from './AgentPicker';
import SessionHistory from './SessionHistory';

function AiChatPanel() {
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const resetConversation = useAiStore((s) => s.resetConversation);
  const errorMessage = useAiStore((s) => s.errorMessage);
  const setError = useAiStore((s) => s.setError);
  const authNotice = useAiStore((s) => s.authNotice);
  const setAuthNotice = useAiStore((s) => s.setAuthNotice);
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

      {/* Input */}
      <ChatInput />
    </div>
  );
}

export default AiChatPanel;
