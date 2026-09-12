/**
 * "Copy" and "Ask AI" for the two error surfaces — the store/clipboard wiring
 * only. All the meaning (what an error snapshot says, and the caps) lives in
 * the pure `data/error-report.ts`, the same split `fix-console-error.ts` keeps
 * with `prompts/console-repair.ts`.
 *
 * Ask AI deliberately does NOT send. It stages a chip and reveals the panel so
 * the user can type their own question — that is the difference from the
 * console's Fix button, which fires a repair prompt immediately.
 */

import {
  buildErrorReport,
  capStoredEntries,
  mergeEntries,
  normalizeConsoleEntries,
  normalizeDiagnostics,
  type ErrorReportEntry,
  type ErrorReportSource,
} from '../data/error-report';
import { newAttachmentId } from './stage-file';
import { copyToClipboard } from '../../../utils/copy-to-clipboard';
import type { Attachment } from './types';
import type { UnityLogEntry } from '../../../types/unity';
import type { DiagnosticItem } from '../../../types';

export type ErrorSelection =
  | { source: 'unity-console'; entries: UnityLogEntry[] }
  | { source: 'problems'; items: DiagnosticItem[]; workspacePath: string | null };

type ErrorReportAttachment = Extract<Attachment, { kind: 'error-report' }>;

function entriesOf(selection: ErrorSelection): ErrorReportEntry[] {
  return selection.source === 'unity-console'
    ? normalizeConsoleEntries(selection.entries)
    : normalizeDiagnostics(selection.items, selection.workspacePath);
}

/** The rendered text for a selection — exactly what "Copy" puts on the clipboard. */
export function errorSelectionText(selection: ErrorSelection): string {
  return buildErrorReport(selection.source, entriesOf(selection), Date.now()).body;
}

/**
 * Copy a selection of errors as plain text.
 *
 * Returns whether the write landed, so the caller can say so on the button
 * rather than leaving a stale paste looking like a success.
 */
export function copyErrorReport(selection: ErrorSelection): Promise<boolean> {
  return copyToClipboard(errorSelectionText(selection));
}

/**
 * Stage a selection of errors as chat context and reveal the AI panel.
 *
 * Two deliberate choices:
 *
 * - **Merges into an already-staged, unsent report from the same surface**
 *   instead of adding a second chip. Clicking Ask AI on three rows leaves one
 *   `3 errors` chip — the outcome row multi-select would have given, without a
 *   selection model over a virtualized list whose backing array mutates while
 *   you look at it.
 * - **Stages into the store directly**, not through the `ai-stage-paths`
 *   CustomEvent that file drops use. That listener lives inside `AiChatPanel`,
 *   which is not mounted while the AI panel is closed — and "Ask AI" is
 *   clicked from the bottom panel, most often with the panel closed, so the
 *   event would fire into nothing. `fixConsoleError` avoids it for the same
 *   reason.
 *
 * The mode is left alone: attaching context is not choosing an action, and Ask
 * mode ("explain this") is a perfectly good thing to want here.
 */
export async function attachErrorReport(selection: ErrorSelection): Promise<void> {
  const entries = entriesOf(selection);
  if (entries.length === 0) return;

  const { useAiStore } = await import('../../../stores/ai');
  const { useUiStore } = await import('../../../stores/ui');

  const ai = useAiStore.getState();
  const existing = ai.attachments.find(
    (a): a is ErrorReportAttachment => a.kind === 'error-report' && a.source === selection.source,
  );

  if (existing) {
    ai.replaceAttachment(existing.id, {
      ...existing,
      entries: capStoredEntries(selection.source, mergeEntries(existing.entries, entries)),
      capturedAt: Date.now(),
    });
  } else {
    ai.addAttachment({
      kind: 'error-report',
      id: newAttachmentId(),
      source: selection.source,
      entries: capStoredEntries(selection.source, entries),
      capturedAt: Date.now(),
    });
  }

  useUiStore.getState().setActiveRightSidebarView('ai-panel');
  useUiStore.getState().setRightSidebarVisible(true);

  // Next frame: on the first Ask AI with the panel closed, `ChatInput` has not
  // mounted yet at this point, so a synchronous dispatch reaches no listener.
  requestAnimationFrame(() => window.dispatchEvent(new CustomEvent('ai-focus-composer')));
}

/** Reveal the panel an error report was captured from (the chip's click-through). */
export async function revealErrorSource(source: ErrorReportSource): Promise<void> {
  const { useUiStore } = await import('../../../stores/ui');
  useUiStore.getState().setBottomPanelVisible(true);
  useUiStore.getState().setActiveBottomTab(source === 'unity-console' ? 'unity-console' : 'problems');
}
