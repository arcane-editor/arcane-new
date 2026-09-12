import { useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../stores/ui';
import { useAiStore } from '../../../stores/ai';
import { useProjectContextStore } from '../../../stores/project-context';
import { AiChatPanel, MaximizedAiOverlay } from '../../ai-panel';
import { UnityInspectorPanel } from '../../unity-scriptable-objects';
import { ErrorBoundary } from '../../../components/ErrorBoundary';

function RightSidebarPanel() {
  const activeView = useUiStore((s) => s.activeRightSidebarView);
  const maximized = useUiStore((s) => s.aiPanelMaximized);
  const visible = useUiStore((s) => s.rightSidebarVisible);
  const generation = useAiStore((s) => s.conversationGeneration);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const inspector = activeView === 'unity-inspector' && isUnityProject && !maximized;
  // React always renders into the same portal container. Moving its host keeps
  // Lexical nodes, selection, question drafts and transcript state alive.
  const [host] = useState(() => {
    const node = document.createElement('div');
    node.style.height = '100%';
    return node;
  });
  const dock = useRef<HTMLDivElement>(null);
  const overlay = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const target = maximized ? overlay.current : dock.current;
    if (!target || host.parentElement === target) return;
    const focused = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    const selection = window.getSelection();
    const range = focused && selection?.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
    target.appendChild(host);
    if (focused) {
      focused.focus({ preventScroll: true });
      if (range && selection) { selection.removeAllRanges(); selection.addRange(range); }
    }
  }, [host, maximized]);
  useLayoutEffect(() => () => host.remove(), [host]);
  return <>
    <div ref={dock} style={{ height: '100%', display: inspector || maximized ? 'none' : undefined }} />
    {inspector && <ErrorBoundary fallback="Inspector unavailable."><UnityInspectorPanel /></ErrorBoundary>}
    {maximized && <MaximizedAiOverlay><div ref={overlay} style={{ height: '100%' }} /></MaximizedAiOverlay>}
    {createPortal(<ErrorBoundary resetKey={`${visible}:${generation}`} fallback="AI panel crashed. Retry, or close and reopen it."><AiChatPanel /></ErrorBoundary>, host)}
  </>;
}

export default RightSidebarPanel;
