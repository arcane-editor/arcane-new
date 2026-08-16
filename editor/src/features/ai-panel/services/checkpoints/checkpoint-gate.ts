// Checkpoint-gate (P5.2) — the write/edit-side hook for per-turn checkpoints.
// BEFORE delegating to the wrapped write/edit tool, snapshot the file's
// CURRENT on-disk content (or `null` if it doesn't exist yet) so the
// just-started turn can later be restored. This must happen before the
// delegate call — reading after would see the NEW content, not the pre-image
// the whole feature exists to preserve.
//
// Wiring (agent-service.ts's `createToolsForPromptMode`): `wrapCs(withWriteApproval(withCheckpoint(tool)))`
// — checkpoint is the INNERMOST wrapper (closest to the raw write/edit tool),
// with P5.3's `withWriteApproval` (write-approval-gate.ts) layered directly
// outside it, and the analyzer/lsp/compile gates outside that. None of the
// cs-gates can prevent the underlying write from being attempted (they only
// annotate the result afterward) — but `withWriteApproval` CAN and does: a
// rejected write returns before ever calling this gate's `execute`, so no
// snapshot is recorded for it. The one pre-write rejection the inner tools DO
// make themselves is the Assets/ sandbox: vendor/tools/write.ts and edit.ts
// call `resolveWithinRoot` internally and silently return an error-text
// result (no write, no onFileWritten) for out-of-root paths. This gate
// applies the SAME `allowedRoot` check up front and skips the snapshot when
// the path is out of root — otherwise it would record phantom entries for
// writes that never happen (wrong "Checkpoint · N files" counts).
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
import { resolveWithinRoot, PathOutsideRootError, type AllowedRoots } from '../vendor/tools/path-utils';
import { useSettingsStore } from '../../../../stores/settings';
import { useCheckpointsStore } from '../../../../stores/checkpoints';

export interface CheckpointGateDeps {
  isEnabled: () => boolean;
  /** Reads the file's current content; resolves `null` if it doesn't exist (or is unreadable). */
  readBeforeContent: (absPath: string) => Promise<string | null>;
  /**
   * `toolCallId` (T6) — the tool `execute` call's own `id`, threaded through
   * so the recorded `CheckpointEntry` can carry it (see
   * `stores/checkpoints.ts`'s `recordPreWrite` and
   * `checkpoint-selection.ts`'s `findCheckpointTurnForToolCall`). Optional so
   * existing fakes/deps that don't care about it keep compiling unchanged.
   */
  recordPreWrite: (absPath: string, beforeContent: string | null, toolCallId?: string) => void;
}

export interface CheckpointGateOptions {
  /**
   * The same Assets/ sandbox root the wrapped write/edit tool was created
   * with (null = no sandbox). Must match, or this gate snapshots paths the
   * inner tool will refuse to write.
   */
  allowedRoot?: AllowedRoots;
  deps?: CheckpointGateDeps;
}

function defaultIsEnabled(): boolean {
  return useSettingsStore.getState().getSetting('ai.checkpoints.enabled') !== false;
}

async function defaultReadBeforeContent(absPath: string): Promise<string | null> {
  return invoke<string>('read_file', { path: absPath }).catch(() => null);
}

function defaultRecordPreWrite(absPath: string, beforeContent: string | null, toolCallId?: string): void {
  useCheckpointsStore.getState().recordPreWrite(absPath, beforeContent, toolCallId);
}

const DEFAULT_DEPS: CheckpointGateDeps = {
  isEnabled: defaultIsEnabled,
  readBeforeContent: defaultReadBeforeContent,
  recordPreWrite: defaultRecordPreWrite,
};

export function withCheckpoint(
  tool: AgentTool,
  cwd: string,
  options: CheckpointGateOptions = {},
): AgentTool {
  const deps = options.deps ?? DEFAULT_DEPS;
  const allowedRoot = options.allowedRoot ?? null;
  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      if (!deps.isEnabled()) {
        return tool.execute(id, params, signal, onUpdate);
      }

      const p = (params as { path?: string }).path;
      if (p) {
        let absPath: string | null;
        try {
          absPath = resolveWithinRoot(p, cwd, allowedRoot);
        } catch (err) {
          // Out-of-root: the inner tool will reject this write itself (its
          // own resolveWithinRoot call) — don't record a phantom snapshot.
          if (err instanceof PathOutsideRootError) {
            absPath = null;
          } else {
            throw err;
          }
        }
        if (absPath !== null) {
          const before = await deps.readBeforeContent(absPath);
          deps.recordPreWrite(absPath, before, id);
        }
      }

      // Delegate unconditionally, and return the inner result untouched —
      // even a failed write is fine to have snapshotted (the plan just
      // writes back the same content, a no-op).
      return tool.execute(id, params, signal, onUpdate);
    },
  };
}
