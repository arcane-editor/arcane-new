/**
 * EmptyState — what the chat shows before the first message of a session.
 *
 * Three things, in the order a new turn actually needs them:
 *
 *  1. what the assistant is looking at (real index state, never a claim it
 *     cannot back — see `groundingLabel`),
 *  2. what pressing Enter will do, as a column ordered by how much each mode
 *     may touch, and
 *  3. something to send, prefilled into the composer rather than fired off, so
 *     a starter is a first draft instead of a surprise.
 *
 * (2) is the load-bearing part. The mode used to be legible only by reading
 * the composer pill, which made it easy to send an editing request believing
 * you were in Ask — the same problem the composer's mode hairline was added
 * for and did not really solve. An empty panel is the one moment there is room
 * to answer it properly, and it costs nothing: this is gone the instant a
 * conversation starts.
 */

import { useAiStore } from '../../../stores/ai';
import { useProjectContextStore } from '../../../stores/project-context';
import { useUnityIndexStore } from '../../../stores/unity-index';
import { useWorkspaceStore } from '../../../stores/workspace';
import type { ChatMode } from '../services/types';
import { MODE_LADDER } from '../data/modes';
import { STARTERS, groundingLabel } from '../data/empty-state';

/** Folder name from a full path, for the grounding line. */
function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').filter(Boolean).pop() ?? p;
}

function EmptyState() {
  const mode = useAiStore((s) => s.mode);
  const setMode = useAiStore((s) => s.setMode);
  const workspacePath = useWorkspaceStore((s) => s.workspacePath);
  const isUnityProject = useProjectContextStore((s) => s.isUnityProject);
  const unityVersion = useProjectContextStore((s) => s.unityVersion);
  const indexStatus = useUnityIndexStore((s) => s.status);
  const assetCount = useUnityIndexStore((s) => s.summary?.guidCount ?? null);

  const grounding = groundingLabel({
    workspaceName: workspacePath ? basename(workspacePath) : null,
    isUnityProject,
    unityVersion,
    indexStatus,
    assetCount,
  });

  function pickStarter(text: string) {
    // The composer owns the Lexical instance and is a sibling of this
    // component, so the request travels the way the other cross-panel actions
    // here do (`ai-new-chat`, `ai-toggle-history`) rather than lifting the
    // editor ref up through AiChatPanel.
    window.dispatchEvent(new CustomEvent('ai-compose-prefill', { detail: { text } }));
  }

  return (
    <div className="ai-panel-empty">
      <p className="ai-panel-empty-grounding">
        <span
          className="ai-panel-empty-dot"
          data-status={workspacePath ? indexStatus : 'idle'}
          aria-hidden="true"
        />
        {grounding}
      </p>

      {workspacePath && (
        <>
          <section className="ai-panel-empty-block">
            <h2 className="ai-panel-empty-eyebrow">On send</h2>
            <div className="ai-panel-empty-modes" role="radiogroup" aria-label="Chat mode">
              {MODE_LADDER.map((m) => {
                const Icon = m.Icon;
                const active = m.value === mode;
                return (
                  <button
                    key={m.value}
                    type="button"
                    role="radio"
                    aria-checked={active}
                    className={`ai-panel-empty-mode${active ? ' is-active' : ''}`}
                    data-mode={m.value}
                    onClick={() => setMode(m.value as ChatMode)}
                  >
                    <Icon size={13} strokeWidth={2} className="ai-panel-empty-mode-icon" />
                    <span className="ai-panel-empty-mode-label">{m.label}</span>
                    <span className="ai-panel-empty-mode-desc">{m.description}</span>
                  </button>
                );
              })}
            </div>
          </section>

          <section className="ai-panel-empty-block">
            <h2 className="ai-panel-empty-eyebrow">Try</h2>
            <div className="ai-panel-empty-starters">
              {STARTERS[mode].map((text) => (
                <button
                  key={text}
                  type="button"
                  className="ai-panel-empty-starter"
                  onClick={() => pickStarter(text)}
                >
                  {text}
                </button>
              ))}
            </div>
          </section>
        </>
      )}
    </div>
  );
}

export default EmptyState;
