/**
 * MessageList — scrollable container that renders the conversation messages.
 *
 * R2-T4 (chat perf Stage 1): this used to (a) subscribe to the whole
 * `toolCalls` Map — so every tool event re-rendered the entire list — and
 * (b) run `scrollIntoView({behavior:'smooth'})` on every token with no
 * at-bottom guard, fighting the user the instant they scrolled up to read
 * earlier output. Both are gone:
 *  - `toolCalls` is no longer read here at all; `ToolCallBlock` self-
 *    subscribes to just its own entry (see that component).
 *  - Scrolling now follows the same gated-autoscroll pattern as
 *    `UnityConsolePanel`: pinned-to-bottom tracked in a ref (not state, so
 *    scrolling itself never triggers a render), a scroll handler that
 *    flips a `showJump` "Jump to bottom" affordance only when the pinned
 *    state actually changes, and a single rAF-guarded `scheduleStick()`
 *    that snaps `scrollTop` to `scrollHeight` ONLY while pinned. It runs
 *    from a `[messages, planPhase]` effect (new messages/phase changes) AND
 *    a `ResizeObserver` on the inner content wrapper, since content can now
 *    grow without a MessageList render at all (e.g. a `ToolCallBlock`
 *    expanding when its diffs arrive).
 */

import { useRef, useEffect, useCallback, useState, memo } from 'react';
import { ArrowDown } from 'lucide-react';
import { useAiStore, type AiMessage } from '../../../stores/ai';
import UserMessage from './UserMessage';
import AssistantMessage from './AssistantMessage';
import PlanActions from './PlanActions';
import PermissionRequestBlock from './PermissionRequestBlock';
import QuestionBlock from './QuestionBlock';
import VerifiedCard from './VerifiedCard';
import CheckpointRow from './CheckpointRow';
import ErrorBlock from './ErrorBlock';
import EmptyState from './EmptyState';

// Matches UnityConsolePanel's "close enough to the bottom" threshold shape
// (that one uses 30px); a slightly wider 40px band here since chat bubbles
// (especially streaming ones growing in real time) are taller than console
// log rows and a strict pixel-perfect bottom is easy to miss by a few px.
const AT_BOTTOM_THRESHOLD_PX = 40;

interface MessageRowProps {
  message: AiMessage;
  /** The user message that started this turn — see `AssistantMessage`'s prop doc. */
  turnUserMessageId: string | null;
  /**
   * Whether to render `PlanActions` immediately after this row — true for
   * exactly the last assistant message while `planPhase === 'awaiting-execute'`
   * (computed by the parent; see `MessageList`'s `lastAssistantIdx`).
   */
  withPlanActions: boolean;
}

/**
 * A single message row, extracted out of `MessageList`'s old inline switch
 * so it can be `memo`'d — the ai store only ever replaces the ONE touched
 * message object (message_update and every resolver map immutably), so a
 * `React.memo`'d row bails on Object.is-equal props for every message OTHER
 * than the one that just changed. Pure extraction: same switch, same cases,
 * same DOM shape, same CheckpointRow fusion under a user message, same
 * PlanActions placement — no behavior change.
 */
const MessageRow = memo(function MessageRow({
  message,
  turnUserMessageId,
  withPlanActions,
}: MessageRowProps) {
  let node: React.ReactNode;

  switch (message.role) {
    case 'user':
      node = (
        <div>
          <UserMessage message={message} />
          <CheckpointRow userMessageId={message.id} />
        </div>
      );
      break;
    case 'assistant':
      node = <AssistantMessage message={message} turnUserMessageId={turnUserMessageId} />;
      break;
    case 'permissionRequest':
      node = <PermissionRequestBlock message={message} />;
      break;
    case 'questionRequest':
      node = <QuestionBlock message={message} />;
      break;
    case 'verifiedPass':
      node = <VerifiedCard message={message} />;
      break;
    case 'error':
      node = <ErrorBlock message={message} />;
      break;
    case 'system':
      node = <div className="ai-panel-system-message">{message.text}</div>;
      break;
    // toolResult messages are rendered inline via ToolCallBlock
    default:
      node = null;
  }

  if (withPlanActions) {
    return (
      <div>
        {node}
        <PlanActions />
      </div>
    );
  }
  return <>{node}</>;
});

function MessageList() {
  const messages = useAiStore((s) => s.messages);
  const planPhase = useAiStore((s) => s.planPhase);

  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  // Mutable, not state — read/written on every scroll event without
  // triggering a render; only `showJump` (below) is state, and only flips
  // when the pinned/unpinned boundary is actually crossed.
  const pinnedRef = useRef(true);
  const [showJump, setShowJump] = useState(false);
  const rafRef = useRef<number | null>(null);

  // Snaps scrollTop to scrollHeight, but only when still pinned to the
  // bottom, and at most once per animation frame no matter how many times
  // it's requested in that frame (the effect below AND the ResizeObserver
  // can both fire for the same content change).
  const scheduleStick = useCallback(() => {
    if (rafRef.current !== null) return;
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      const el = scrollRef.current;
      if (!el || !pinnedRef.current) return;
      el.scrollTop = el.scrollHeight;
    });
  }, []);

  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const isAtBottom =
      el.scrollHeight - el.scrollTop - el.clientHeight < AT_BOTTOM_THRESHOLD_PX;
    pinnedRef.current = isAtBottom;
    // Flip-only: avoids a state update (and re-render) on every scroll
    // event, only when the "should the jump button show" answer changes.
    setShowJump((prev) => (prev === !isAtBottom ? prev : !isAtBottom));
  }, []);

  // New content (a token, a new message, a plan-phase change) — stick to
  // the bottom if the user was already there.
  useEffect(() => {
    scheduleStick();
  }, [messages, planPhase, scheduleStick]);

  // Content can grow WITHOUT a MessageList render at all — e.g. a
  // ToolCallBlock expanding when its diffs arrive, or a CheckpointRow's
  // inline confirm state. A ResizeObserver on the inner content wrapper
  // catches those too.
  useEffect(() => {
    const contentEl = contentRef.current;
    if (!contentEl) return;
    const observer = new ResizeObserver(() => {
      scheduleStick();
    });
    observer.observe(contentEl);
    return () => observer.disconnect();
  }, [scheduleStick]);

  useEffect(() => {
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, []);

  function jumpToBottom() {
    pinnedRef.current = true;
    setShowJump(false);
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }

  // Find the index of the last assistant message so we can render PlanActions
  // immediately after it when we're awaiting user approval.
  let lastAssistantIdx = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'assistant') {
      lastAssistantIdx = i;
      break;
    }
  }

  const showPlanActions = planPhase === 'awaiting-execute';

  // P5.1: track the most recent preceding user message id so ToolCallBlock's
  // per-file Revert can look up the right checkpoint turn
  // (`findCheckpointTurnForPath` matches by (userMessageId, path) — see that
  // function's header for why toolCallId isn't available instead).
  let currentUserMessageId: string | null = null;

  return (
    <div className="ai-panel-messages-wrap">
      <div
        className={`ai-panel-messages${messages.length === 0 ? ' is-empty' : ''}`}
        ref={scrollRef}
        onScroll={handleScroll}
      >
        {messages.length === 0 && <EmptyState />}
        {/* The content wrapper stays mounted even with nothing in it: the
            ResizeObserver effect below binds to `contentRef` once, on a
            `[scheduleStick]` dep that never changes, so unmounting this for
            the empty state would leave the observer unbound for the rest of
            the session and break autoscroll from the first message on. */}
        <div ref={contentRef} className="ai-panel-messages-content">
          {messages.map((msg, idx) => {
            if (msg.role === 'user') currentUserMessageId = msg.id;
            return (
              <MessageRow
                key={msg.id}
                message={msg}
                turnUserMessageId={currentUserMessageId}
                withPlanActions={idx === lastAssistantIdx && showPlanActions}
              />
            );
          })}
        </div>
      </div>

      {showJump && (
        <button
          type="button"
          className="ai-jump-to-bottom"
          onClick={jumpToBottom}
          title="Jump to bottom"
        >
          <ArrowDown size={14} />
          Jump to bottom
        </button>
      )}
    </div>
  );
}

export default MessageList;
