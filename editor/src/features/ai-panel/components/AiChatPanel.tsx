/**
 * AiChatPanel — top-level container for the AI chat sidebar.
 * Composes the header (agent picker + new-chat button), message list,
 * input area, and error banner.
 *
 * Sign-in gate only applies to the Arcane agent. The Claude agent uses the
 * user's local `claude` CLI auth and works without any Arcane account.
 */

import { useState } from 'react';
import { RotateCcw, History } from 'lucide-react';
import { useAiStore } from '../../../stores/ai';
import { useAuthStore } from '../../../stores/auth';
import { resetAgentService } from '../services/agent-service';
import { resetClaudeAgentService } from '../services/claude-agent-service';
import MessageList from './MessageList';
import ChatInput from './ChatInput';
import AiSignInGate from './AiSignInGate';
import AgentPicker from './AgentPicker';
import SessionHistory from './SessionHistory';

function AiChatPanel() {
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const selectedAgent = useAiStore((s) => s.selectedAgent);
  const resetConversation = useAiStore((s) => s.resetConversation);
  const errorMessage = useAiStore((s) => s.errorMessage);
  const setError = useAiStore((s) => s.setError);
  const [historyOpen, setHistoryOpen] = useState(false);

  // Sign-in only gates the Arcane agent. Claude bypasses this — it uses the
  // user's `claude` CLI auth, not the Arcane account.
  if (!loggedIn && selectedAgent === 'arcane') {
    return (
      <div className="ai-panel">
        <div className="ai-panel-header">
          <AgentPicker />
        </div>
        <AiSignInGate />
      </div>
    );
  }

  function handleNewChat() {
    resetConversation();
    if (selectedAgent === 'arcane') {
      resetAgentService();
    } else {
      void resetClaudeAgentService();
    }
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
