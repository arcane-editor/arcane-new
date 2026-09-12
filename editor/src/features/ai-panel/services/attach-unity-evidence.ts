import type { UnityEvidence } from '../../../types/unity-evidence';
import { newAttachmentId } from './stage-file';
export async function attachUnityEvidence(evidence: UnityEvidence): Promise<void> {
  const { useAiStore } = await import('../../../stores/ai');
  const { useUiStore } = await import('../../../stores/ui');
  // Own the snapshot. Later resume/frame-selection must not change staged evidence.
  const frozen = structuredClone(evidence);
  useAiStore.getState().addAttachment({ kind: 'unity-evidence', id: newAttachmentId(), evidence: frozen });
  useUiStore.getState().setActiveRightSidebarView('ai-panel');
  useUiStore.getState().setRightSidebarVisible(true);
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('ai-focus-composer')));
}
