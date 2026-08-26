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
import {
  POINTER_DRAG_DROP,
  type PointerDragDropDetail,
} from '../../../utils/pointer-drag';
import { resetChatBackend } from '../services/chat-backend';
import { buildFileAttachment, isAlreadyStaged } from '../services/stage-file';
import MessageList from './MessageList';
import ClaudeSetupGate from './ClaudeSetupGate';
import ReviewBar from './ReviewBar';
import PlanList from './PlanList';
import ChatInput from './ChatInput';
import AiSignInGate from './AiSignInGate';
import AiVerifyEmailGate from './AiVerifyEmailGate';
import AgentPicker from './AgentPicker';
import SessionHistory from './SessionHistory';
import Tooltip from '../../../components/Tooltip';

function AiChatPanel() {
  const loggedIn = useAuthStore((s) => s.loggedIn);
  const resetConversation = useAiStore((s) => s.resetConversation);
  const errorMessage = useAiStore((s) => s.errorMessage);
  const setError = useAiStore((s) => s.setError);
  const authNotice = useAiStore((s) => s.authNotice);
  const setAuthNotice = useAiStore((s) => s.setAuthNotice);
  const verificationRequired = useAiStore((s) => s.verificationRequired);
  const [historyOpen, setHistoryOpen] = useState(false);

  // T5: the notice explaining WHY the user was signed out (hosted-stream's
  // 401/403 path) should disappear once they've actually logged back in,
  // rather than lingering into the next signed-in session.
  useEffect(() => {
    if (loggedIn) setAuthNotice(null);
  }, [loggedIn, setAuthNotice]);

  function handleNewChat() {
    resetConversation();
    // Whichever backend is selected — an external agent kept running here
    // would answer the "new" chat with the old thread's context.
    resetChatBackend();
  }

  // OS file drops. Tauri intercepts those natively, so no DOM drop event ever
  // reaches this element and App.tsx's window-level handler hit-tests the
  // coordinate instead (`services/drop-target.ts`) and forwards the paths
  // here. In-webview drags — explorer tree, tab bar — take the React handlers
  // further down instead.
  useEffect(() => {
    function onStagePaths(e: Event) {
      const paths = (e as CustomEvent<{ paths?: string[] }>).detail?.paths;
      if (!Array.isArray(paths) || paths.length === 0) return;

      const { attachments, addAttachment } = useAiStore.getState();
      const workspacePath = useWorkspaceStore.getState().workspacePath;

      // Staged inside one getState() read, then de-duplicated against the list
      // as it grows: dropping the same file twice in one gesture would
      // otherwise produce two identical chips.
      const staged = [...attachments];
      for (const path of paths) {
        if (isAlreadyStaged(staged, path)) continue;
        const attachment = buildFileAttachment(path, workspacePath);
        staged.push(attachment);
        addAttachment(attachment);
      }
    }
    window.addEventListener('ai-stage-paths', onStagePaths);

    // In-app drags (a tab, a tree row). These arrive on `window` from
    // `utils/pointer-drag.ts` rather than as DOM drop events, because Tauri's
    // native handler swallows HTML5 drags before the webview sees them.
    function onPointerDrop(e: Event) {
      const { payload, zoneId } = (e as CustomEvent<PointerDragDropDetail>).detail;
      if (zoneId !== 'ai-panel') return;
      if (payload.isDir) {
        useAiStore.getState().setError('Folders cannot be attached as context — drop a file instead.');
        return;
      }
      window.dispatchEvent(
        new CustomEvent('ai-stage-paths', { detail: { paths: [payload.path] } }),
      );
    }
    window.addEventListener(POINTER_DRAG_DROP, onPointerDrop);

    return () => {
      window.removeEventListener('ai-stage-paths', onStagePaths);
      window.removeEventListener(POINTER_DRAG_DROP, onPointerDrop);
    };
  }, []);

  // The header buttons and the mod+shift+L / mod+shift+H chords must do the
  // same thing, so the commands dispatch these events rather than duplicating
  // the handlers. The panel owns `historyOpen`, which a command cannot reach.
  useEffect(() => {
    const onNewChat = () => handleNewChat();
    const onToggleHistory = () => setHistoryOpen((v) => !v);
    window.addEventListener('ai-new-chat', onNewChat);
    window.addEventListener('ai-toggle-history', onToggleHistory);
    return () => {
      window.removeEventListener('ai-new-chat', onNewChat);
      window.removeEventListener('ai-toggle-history', onToggleHistory);
    };
  }, []);

  // HOOKS END HERE. The two gates below are conditional RETURNS — any hook
  // added after them changes the hook count when loggedIn /
  // verificationRequired flips while the panel is mounted, and React 19
  // throws ("Rendered more/fewer hooks") on the first-sign-in mainline flow.

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

  // Files dragged in from the explorer tree or the tab bar. These are
  // in-webview HTML5 drags, unaffected by Tauri's native interception of OS
  // file drops — those still open as editor tabs via App.tsx.
  return (
    <div
      className="ai-panel"
      // Both drop paths land here. OS drops are hit-tested by coordinate in
      // App.tsx (Tauri handles those natively); in-app drags resolve this zone
      // through `data-drop-zone`. `data-drag-over` is set by pointer-drag.ts.
      data-drop-zone="ai-panel"
    >
      {/* Header */}
      <div className="ai-panel-header">
        <AgentPicker />
        <div className="ai-panel-header-actions">
          <Tooltip label="Chat history" commandId="ai.history" side="bottom">
            <button
              className="ai-panel-header-btn"
              onClick={() => setHistoryOpen((v) => !v)}
            >
              <History size={12} />
              <span>History</span>
            </button>
          </Tooltip>
          <Tooltip label="New Chat" commandId="ai.newChat" side="bottom">
            <button
              className="ai-panel-new-chat"
              onClick={handleNewChat}
            >
              <RotateCcw size={12} />
              <span>New Chat</span>
            </button>
          </Tooltip>
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

      {/* External-agent setup / sign-in. Rendered unconditionally and returns
          null once the agent is ready — a conditional return HERE would sit
          below the hooks and change their count when it flips (see the
          HOOKS END HERE note above). */}
      <ClaudeSetupGate />

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

      {/* Drop affordance. Always mounted and shown by CSS, because the two
          drop paths signal differently and neither goes through React state:
          an in-app drag sets `data-drag-over` (pointer-drag.ts) and an OS drag
          sets `.ai-panel--drop-over` (App.tsx's coordinate hit-test).
          `pointer-events: none` is load-bearing — the overlay sits above the
          panel, and intercepting the pointer would swallow the very drop it is
          advertising, and break `elementFromPoint`. */}
      <div className="ai-panel-drop-overlay">
        <div className="ai-panel-drop-overlay-label">
          <Paperclip size={14} />
          <span>Drop to add as context</span>
        </div>
      </div>
    </div>
  );
}

export default AiChatPanel;
