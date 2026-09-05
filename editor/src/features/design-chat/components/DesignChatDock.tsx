import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ChevronDown, ChevronUp, History, SquarePen, X } from 'lucide-react';
import { useAiStore, selectPendingQuestion } from '../../../stores/ai';
import { useDesignChatStore, type DockGeometry } from '../../../stores/design-chat';
import {
  dispatchComposerSend,
  getChatBackend,
  humanizeToolCall,
  imageFromBlob,
  imagesFromPaths,
  isImagePath,
  pickImages,
  promptTextForImages,
  resolvePendingApproval,
  shouldRouteToQuestion,
  type ImageAttachment,
} from '../../ai-panel';
import { DESIGN_STAGE_PATHS } from '../services/dock-drop';
import { buildDesignRows, designStatusLine } from '../services/design-rows';
import { applyDockDrag, clampDock, HANDLE_CURSOR, type DockHandle } from '../services/dock-resize';
import {
  adoptDesignSession,
  openDesignThread,
  startDesignThread,
} from '../services/design-session';
import { sameDocument } from '../services/design-session-policy';
import { renderAttachment, renderAttachNote } from '../services/render-attach';
import { DesignHistory } from './DesignHistory';
import { DesignLog } from './DesignLog';
import { DesignComposer } from './DesignComposer';

interface Props {
  /** Workspace-relative path of the `.uxml` on the canvas. */
  documentPath: string;
  /** Basename, for the header. */
  documentName: string;
}

/** Every edge and every corner, plus the header. */
const RESIZE_HANDLES: DockHandle[] = ['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'];

/**
 * The floating design chat, over the UXML canvas.
 *
 * A SHELF rather than a window: a hairline border and a translucent ground, so
 * the artboard stays visible behind it and it reads as part of the canvas
 * chrome rather than an app dropped on top. That is also why there is no drop
 * shadow — a shadow is what turns this into the standard floating card, and the
 * hairline already does the separating.
 *
 * Draggable by its header and resizable from all eight edges and corners. The
 * geometry maths lives in `dock-resize.ts`, where it is unit-tested: the dock
 * is anchored by its left and its BOTTOM, so the four edges do four different
 * things to the four numbers and half of them invert.
 *
 * Pointer events throughout. `dragstart` never fires anywhere in this app:
 * Tauri installs a native drag-drop handler on the webview and its listener
 * returns `true` unconditionally, so HTML5 DnD is dead here. Two features
 * shipped inert that way before this one (see editor/CLAUDE.md).
 */
export function DesignChatDock({ documentPath, documentName }: Props) {
  const collapsed = useDesignChatStore((s) => s.collapsed);
  const setCollapsed = useDesignChatStore((s) => s.setCollapsed);
  const setOpen = useDesignChatStore((s) => s.setOpen);
  const geometry = useDesignChatStore((s) => s.geometry);
  const setGeometry = useDesignChatStore((s) => s.setGeometry);
  const placed = useDesignChatStore((s) => s.placed);
  // Survives the unmount a tab switch causes — see `stores/design-chat.ts`.
  const draft = useDesignChatStore((s) => s.draft);
  const setDraft = useDesignChatStore((s) => s.setDraft);
  const storedRender = useDesignChatStore((s) => s.render);
  const sessionId = useAiStore((s) => s.sessionId);
  const [historyOpen, setHistoryOpen] = useState(false);
  const attachRender = useDesignChatStore((s) => s.attachRender);
  const setAttachRender = useDesignChatStore((s) => s.setAttachRender);
  const markRenderSent = useDesignChatStore((s) => s.markRenderSent);

  const messages = useAiStore((s) => s.messages);
  const toolCalls = useAiStore((s) => s.toolCalls);
  const isAgentRunning = useAiStore((s) => s.isAgentRunning);
  const designDocument = useAiStore((s) => s.designDocument);
  const mode = useAiStore((s) => s.mode);
  const attachments = useAiStore((s) => s.attachments);
  // The turn stays open until this is answered — `ask_user` has no timeout.
  const pendingQuestion = useAiStore(selectPendingQuestion);
  const addAttachment = useAiStore((s) => s.addAttachment);
  const removeAttachment = useAiStore((s) => s.removeAttachment);

  const [notice, setNotice] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  // Only images are shown here. The staging store is shared with the AI panel,
  // which can hold file and Unity-context attachments this surface has no way
  // to render — dropping them into a thumbnail row would draw a broken picture.
  const images = useMemo(
    () => attachments.filter((a): a is ImageAttachment => a.kind === 'image'),
    [attachments],
  );

  const stage = useCallback(
    (staged: { attachments: ImageAttachment[]; errors: string[] }) => {
      for (const attachment of staged.attachments) addAttachment(attachment);
      // Reported inline under the composer rather than through the AI panel's
      // banner, which is somewhere else on screen entirely.
      if (staged.errors.length > 0) setNotice(staged.errors.join(' • '));
    },
    [addAttachment],
  );

  const pick = useCallback(() => {
    setNotice(null);
    void pickImages().then(stage);
  }, [stage]);

  const pasteImages = useCallback(
    (blobs: Blob[]): boolean => {
      setNotice(null);
      void Promise.all(blobs.map((b, i) => imageFromBlob(b, `Pasted image ${i + 1}`))).then(
        (staged) => stage({ attachments: staged, errors: [] }),
      );
      return true;
    },
    [stage],
  );

  // An OS drop lands as a window coordinate, never as a DOM event — Tauri
  // handles file drops natively. `App.tsx` hit-tests the dock and dispatches
  // this; see `services/dock-drop.ts`.
  useEffect(() => {
    function onStagePaths(event: Event) {
      const paths = (event as CustomEvent<{ paths: string[] }>).detail?.paths ?? [];
      const pictures = paths.filter(isImagePath);
      if (pictures.length === 0) {
        // Said rather than ignored: a file dropped on a panel that silently
        // does nothing reads as a broken drop target.
        setNotice('Only images can be dropped here — use the AI panel for other files.');
        return;
      }
      setNotice(null);
      void imagesFromPaths(pictures).then(stage);
    }
    window.addEventListener(DESIGN_STAGE_PATHS, onStagePaths);
    return () => window.removeEventListener(DESIGN_STAGE_PATHS, onStagePaths);
  }, [stage]);

  /**
   * Whether the live conversation IS this document's design thread.
   *
   * Stated in the header rather than assumed, because the dock is a view onto
   * the one shared conversation: when it is showing somebody else's thread,
   * saying so is the difference between a second window and a lie.
   */
  const live = sameDocument(designDocument, documentPath) && mode === 'design';

  // A render belongs to the document it was taken of. The dock outlives a tab
  // switch (the store does not), so without this the log would show the last
  // screen you were designing under the name of the one you are looking at.
  const render = storedRender && sameDocument(storedRender.documentPath, documentPath)
    ? storedRender
    : null;

  // Said before it happens: a picture silently added to a message is a surprise
  // on the bill and a surprise in the transcript.
  const attachNote = renderAttachNote({ render, staged: attachments, enabled: attachRender });

  const rows = useMemo(
    () =>
      live
        ? buildDesignRows(messages, toolCalls, (n, a, s) => humanizeToolCall(n, a, s).title)
        : [],
    [live, messages, toolCalls],
  );
  const status = designStatusLine(rows, live && isAgentRunning);

  /** The canvas the dock floats over. Read at gesture time, never cached. */
  const bounds = useCallback((): { width: number; height: number } => {
    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    return parent ? { width: parent.clientWidth, height: parent.clientHeight } : { width: 0, height: 0 };
  }, []);

  // Centre it until the user positions it themselves, then never again, and
  // keep it inside the canvas when that canvas changes size either way.
  useEffect(() => {
    const parent = rootRef.current?.offsetParent as HTMLElement | null;
    if (!parent || typeof ResizeObserver === 'undefined') return;
    const fit = () => {
      const size = { width: parent.clientWidth, height: parent.clientHeight };
      if (size.width === 0 || size.height === 0) return;
      const current = useDesignChatStore.getState();
      const next = current.placed
        ? clampDock(current.geometry, size)
        : { ...clampDock(current.geometry, size), x: Math.max(12, (size.width - current.geometry.width) / 2) };
      const g = current.geometry;
      if (next.x === g.x && next.bottom === g.bottom && next.width === g.width && next.height === g.height) {
        return;
      }
      // `byHand: false` — an automatic fit must not claim the dock as
      // user-positioned, or the first canvas resize would stop it centring.
      current.setGeometry(next, false);
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    return () => ro.disconnect();
  }, [placed]);

  const drag = useRef<{
    handle: DockHandle;
    pointerX: number;
    pointerY: number;
    start: DockGeometry;
    bounds: { width: number; height: number };
  } | null>(null);

  const onPointerDown = useCallback(
    (handle: DockHandle) => (e: React.PointerEvent) => {
      if (e.button !== 0) return;
      const size = bounds();
      if (size.width === 0) return;
      e.preventDefault();
      (e.currentTarget as Element).setPointerCapture?.(e.pointerId);
      drag.current = {
        handle,
        pointerX: e.clientX,
        pointerY: e.clientY,
        start: useDesignChatStore.getState().geometry,
        bounds: size,
      };
    },
    [bounds],
  );

  const onPointerMove = useCallback(
    (e: React.PointerEvent) => {
      const d = drag.current;
      if (!d) return;
      setGeometry(
        applyDockDrag(d.start, d.handle, e.clientX - d.pointerX, e.clientY - d.pointerY, d.bounds),
      );
    },
    [setGeometry],
  );

  const endDrag = useCallback((e: React.PointerEvent) => {
    (e.currentTarget as Element).releasePointerCapture?.(e.pointerId);
    drag.current = null;
  }, []);

  /** Every handle shares one set of pointer callbacks; only the edge differs. */
  const handleProps = (handle: DockHandle) => ({
    onPointerDown: onPointerDown(handle),
    onPointerMove,
    onPointerUp: endDrag,
    onPointerCancel: endDrag,
  });

  const answer = useCallback((toolCallId: string, text: string) => {
    useAiStore.getState().resolveQuestionRequest(toolCallId, { answer: text });
  }, []);

  const permit = useCallback((toolCallId: string, optionId: string) => {
    // Resolves the gate's pending promise, which is what actually releases the
    // blocked tool call; the store row locks itself off the same event.
    resolvePendingApproval(toolCallId, optionId);
  }, []);

  const send = useCallback(() => {
    // Answer-mode routing FIRST, exactly as the panel's composer does it: while
    // a question is pending, typed text ANSWERS it rather than starting a new
    // message. Without this the dock could show the question and still have no
    // way to resolve it, which is the shape of the bug this whole path fixes.
    if (shouldRouteToQuestion({ pendingQuestion: !!pendingQuestion, text: draft })) {
      answer(pendingQuestion!.toolCallId, draft.trim());
      setDraft('');
      return;
    }

    const text = draft.trim();
    // An image on its own is a complete request here — "make it look like this"
    // is the point — so a send is allowed with either half. What it must NOT
    // become is an empty prompt: `promptTextForImages` supplies the words, so
    // the transcript reads as a real request and the provider is never handed
    // an empty content part.
    if ((!text && images.length === 0) || isAgentRunning) return;
    setNotice(null);
    void adoptDesignSession(documentPath).then((outcome) => {
      if (outcome.kind !== 'ready') {
        setNotice(outcome.message);
        return;
      }
      setDraft('');
      // Read at send time, not captured: `adoptDesignSession` awaits, and an
      // image staged in that window still belongs to this message.
      // `dispatchComposerSend` clears the staging store itself.
      const staged = useAiStore.getState().attachments;
      // The picture of the screen the request is about. It can only travel on a
      // user message — tool results drop image content in three places and the
      // server's tool shape has no image variant — so this is where it goes.
      const shot = renderAttachment({
        render: useDesignChatStore.getState().render,
        staged,
        enabled: useDesignChatStore.getState().attachRender,
      });
      const outgoing = shot ? [...staged, shot] : staged;
      if (shot) markRenderSent();
      const imageCount = outgoing.filter((a) => a.kind === 'image').length;
      dispatchComposerSend(promptTextForImages(text, imageCount), outgoing);
    });
  }, [
    draft,
    images.length,
    isAgentRunning,
    documentPath,
    setDraft,
    pendingQuestion,
    answer,
    markRenderSent,
  ]);

  const stop = useCallback(() => {
    void getChatBackend().abort();
  }, []);

  // A new thread, and the one you were in. Both refuse mid-turn for the reason
  // every session swap in this app refuses mid-turn: clearing the conversation
  // under a running loop leaves its gate promise unresolvable and the agent
  // stuck on "already processing".
  const newThread = useCallback(() => {
    setHistoryOpen(false);
    const outcome = startDesignThread(documentPath);
    setNotice(outcome.kind === 'ready' ? null : outcome.message);
  }, [documentPath]);

  const openThread = useCallback((id: string) => {
    setHistoryOpen(false);
    void openDesignThread(id).then((outcome) => {
      setNotice(outcome.kind === 'ready' ? null : outcome.message);
    });
  }, []);

  // Nothing to clear, so the control would be a no-op that looks like an action.
  const canStartNew = rows.length > 0 || !!sessionId;

  const blockedReason = isAgentRunning && !live ? 'Finishing a turn in the AI panel.' : notice;

  return (
    <div
      ref={rootRef}
      className={`design-dock ${collapsed ? 'is-collapsed' : ''}`}
      style={{
        left: geometry.x,
        bottom: geometry.bottom,
        width: geometry.width,
        height: collapsed ? undefined : geometry.height,
      }}
    >
      {!collapsed &&
        RESIZE_HANDLES.map((handle) => (
          <div
            key={handle}
            className={`design-dock-resize is-${handle}`}
            style={{ cursor: HANDLE_CURSOR[handle] }}
            aria-hidden="true"
            {...handleProps(handle)}
          />
        ))}

      <div className="design-dock-header" {...handleProps('move')}>
        <span className="design-dock-title">Design</span>
        <span className="design-dock-doc">{documentName}</span>
        <span className="design-dock-state" data-live={live ? 'yes' : 'no'}>
          {live ? 'live' : 'paused'}
        </span>
        <button
          type="button"
          className="design-dock-icon"
          onClick={newThread}
          onPointerDown={(e) => e.stopPropagation()}
          disabled={!canStartNew || isAgentRunning}
          aria-label="Start a new design thread"
          title={
            isAgentRunning
              ? 'Finishing a turn — you can start a new thread when it is done'
              : 'New thread for this screen. The current one stays in the history.'
          }
        >
          <SquarePen size={12} />
        </button>
        <button
          type="button"
          className={`design-dock-icon${historyOpen ? ' is-on' : ''}`}
          onClick={() => {
            // The dock clips its own overflow, so the list has nowhere to go
            // while collapsed. Asking to see it is asking for the room to.
            if (!historyOpen && collapsed) setCollapsed(false);
            setHistoryOpen((v) => !v);
          }}
          onPointerDown={(e) => e.stopPropagation()}
          aria-expanded={historyOpen}
          aria-label="Past design threads for this screen"
          title="Past design threads for this screen"
        >
          <History size={12} />
        </button>
        <button
          type="button"
          className="design-dock-icon"
          onClick={() => setCollapsed(!collapsed)}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label={collapsed ? 'Expand the design chat' : 'Collapse the design chat'}
        >
          {collapsed ? <ChevronUp size={12} /> : <ChevronDown size={12} />}
        </button>
        <button
          type="button"
          className="design-dock-icon"
          onClick={() => setOpen(false)}
          onPointerDown={(e) => e.stopPropagation()}
          aria-label="Hide the design chat"
          title="Hide the design chat — the Design button in the toolbar brings it back"
        >
          <X size={12} />
        </button>
      </div>

      {historyOpen && (
        <DesignHistory
          documentPath={documentPath}
          documentName={documentName}
          activeId={live ? sessionId : null}
          onOpen={openThread}
          onClose={() => setHistoryOpen(false)}
        />
      )}

      {!collapsed && (
        <DesignLog
          rows={rows}
          status={status}
          emptyHint={`Say what ${documentName} should be, or show it a reference image. Every write lands on the canvas above.`}
          render={render}
          onAnswer={answer}
          onPermission={permit}
        />
      )}

      {blockedReason && <p className="design-dock-blocked">{blockedReason}</p>}

      {attachNote && (
        <p className="design-dock-render-note">
          {attachNote}
          <button
            type="button"
            onClick={() => setAttachRender(false)}
            title="Stop sending the render. Turn this off if the model cannot read images."
          >
            don’t
          </button>
        </p>
      )}

      <DesignComposer
        value={draft}
        onChange={setDraft}
        onSubmit={send}
        onStop={stop}
        // A pending question is the one case where sending mid-run is right:
        // answering it is what unblocks the agent.
        running={live && isAgentRunning && !pendingQuestion}
        blockedReason={blockedReason}
        placeholder="Describe the screen — or drop a reference image"
        images={images}
        onRemoveImage={removeAttachment}
        onPickImages={pick}
        onPasteImages={pasteImages}
      />
    </div>
  );
}

export default DesignChatDock;
