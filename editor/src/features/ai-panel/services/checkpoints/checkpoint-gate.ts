// Checkpoint-gate (P5.2) — the write/edit-side hook for per-turn checkpoints.
// BEFORE delegating to the wrapped write/edit tool, snapshot the file's
// CURRENT on-disk content (or `null` if it doesn't exist yet) so the
// just-started turn can later be restored. This must happen before the
// delegate call — reading after would see the NEW content, not the pre-image
// the whole feature exists to preserve.
//
// Wiring (agent-service.ts's `createToolsForPromptMode`): `wrapCs(withCheckpoint(tool))`
// — checkpoint is the INNERMOST wrapper (closest to the raw write/edit tool),
// with the analyzer/lsp/compile gates layered outside it. None of those gates
// can prevent the underlying write from being attempted (they only annotate
// the result afterward), so every call that reaches this gate proceeds to a
// real write — this gate never needs to guess whether the write "will happen".
// P5.3 will later insert an approval gate OUTSIDE the checkpoint; today's
// order is just gates(checkpoint(tool)).
//
// Settings-gated on `ai.checkpoints.enabled` (default on). Known limitation
// (documented in the P5.2 report too): bash-tool mutations are not
// checkpointed — same scope as the other write/edit-only gates
// (analyzer-gate.ts, compile-gate.ts, verified-pass.ts).
//
// DI note (mirrors lsp-gate.ts's `DiagnosticsFetcher` / verified-pass.ts's
// `VerifiedPassDeps` seams): the defaults reach `useSettingsStore` and
// `useCheckpointsStore` directly (both are Bun-safe top-level imports — see
// `stores/checkpoints.ts`'s header) and read the file via a direct `invoke`
// call rather than importing `tool-operations.ts` (which eagerly pulls in
// `stores/workspace.ts` → the `editor` feature barrel → `@monaco-editor/react`,
// the same Bun-unsafe chain `lsp-gate.ts` avoids the same way).

import { invoke } from '@tauri-apps/api/core';
import type { AgentTool } from '../vendor/types';
import { resolveToCwd } from '../vendor/tools/path-utils';
import { useSettingsStore } from '../../../../stores/settings';
import { useCheckpointsStore } from '../../../../stores/checkpoints';

export interface CheckpointGateDeps {
  isEnabled: () => boolean;
  /** Reads the file's current content; resolves `null` if it doesn't exist (or is unreadable). */
  readBeforeContent: (absPath: string) => Promise<string | null>;
  recordPreWrite: (absPath: string, beforeContent: string | null) => void;
}

function defaultIsEnabled(): boolean {
  return useSettingsStore.getState().getSetting('ai.checkpoints.enabled') !== false;
}

async function defaultReadBeforeContent(absPath: string): Promise<string | null> {
  return invoke<string>('read_file', { path: absPath }).catch(() => null);
}

function defaultRecordPreWrite(absPath: string, beforeContent: string | null): void {
  useCheckpointsStore.getState().recordPreWrite(absPath, beforeContent);
}

const DEFAULT_DEPS: CheckpointGateDeps = {
  isEnabled: defaultIsEnabled,
  readBeforeContent: defaultReadBeforeContent,
  recordPreWrite: defaultRecordPreWrite,
};

export function withCheckpoint(
  tool: AgentTool,
  cwd: string,
  deps: CheckpointGateDeps = DEFAULT_DEPS,
): AgentTool {
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      if (!deps.isEnabled()) {
        return tool.execute(id, params, signal, onUpdate);
      }

      const p = (params as { path?: string }).path;
      if (p) {
        const absPath = resolveToCwd(p, cwd);
        const before = await deps.readBeforeContent(absPath);
        deps.recordPreWrite(absPath, before);
      }

      // Delegate unconditionally, and return the inner result untouched —
      // even a failed write is fine to have snapshotted (the plan just
      // writes back the same content, a no-op).
      return tool.execute(id, params, signal, onUpdate);
    },
  };
}
