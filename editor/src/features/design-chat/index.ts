/**
 * The design chat dock: a floating conversation over the `.uxml` canvas.
 *
 * Dependency direction is one-way — `design-chat` imports `ai-panel`, never the
 * reverse, and `uitoolkit` imports NEITHER. The preview takes the dock as a
 * `ReactNode` slot and `EditorPanel` (which already imports both features) is
 * what composes them. That is deliberate: `ai-panel` already reaches
 * `uitoolkit`'s barrel by dynamic import, and a static `uitoolkit → ai-panel`
 * import on top of it would close the mutual barrel cycle that broke app
 * startup outright once before (editor/CLAUDE.md).
 */

export { DesignChatDock } from './components/DesignChatDock';
export { adoptDesignSession, findDesignSession, isDesignSessionLive } from './services/design-session';
export { preAdoptionCheck, pickDesignSession, sameDocument } from './services/design-session-policy';
export type { AdoptOutcome } from './services/design-session';
export { buildDesignRows, designStatusLine, describeAction } from './services/design-rows';
export type { DesignRow } from './services/design-rows';
export {
  DESIGN_STAGE_PATHS,
  clearDesignDockDropTarget,
  highlightDesignDockDropTarget,
  isDropOnDesignDock,
} from './services/dock-drop';
export { applyDockDrag, clampDock, HANDLE_CURSOR } from './services/dock-resize';
export type { DockHandle } from './services/dock-resize';
