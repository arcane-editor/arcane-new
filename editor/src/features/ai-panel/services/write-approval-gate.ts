/**
 * Pre-apply write approval gate (P5.3) — the fix for the Arcane loop's
 * central trust asymmetry: before this gate, Arcane's write/edit tools
 * applied file changes immediately and only the Claude/ACP path prompted
 * first. `withWriteApproval` makes the Arcane path approve-first too:
 * approve-first is the DEFAULT (`ai.edits.applyMode: 'approve'`), with
 * "Apply all this session" one click away, and serialized Unity assets
 * (.unity/.prefab/.asset/.mat/.controller/.anim) ALWAYS prompt even in auto
 * mode (`ai.edits.alwaysApproveUnityAssets`, default true) — the
 * "we don't silently touch serialized data" guarantee. Checkpoints (P5.2)
 * are what make 'auto' a safe opt-in in the first place.
 *
 * Known tradeoff — preview/apply staleness window for `edit`: the diff shown
 * in the approval prompt is computed from a disk read at prompt time; the
 * real edit tool re-reads and re-applies when the user approves. If the file
 * changed on disk in between (external editor, another tool), the applied
 * result can differ from the preview — `applyEdits` matches the FIRST
 * occurrence of oldText against the fresh content. Accepted for v1: the
 * sequential tool loop makes agent-side interleaving impossible, and
 * checkpoints (P5.2) make any surprise revertable. A pre-execute content
 * recheck would close it if this ever bites in practice.
 *
 * NOT applied to the eval harness (`tooling/unity-eval`) — its `run-task.ts`
 * builds write/edit tools directly (see `buildTools`) without this gate. Eval
 * runs are unattended measurement, not an interactive UX; there's no user to
 * prompt, and blocking a batch eval run on a permission click would just hang
 * it. This mirrors how the eval harness already gets its own analyzer-gate
 * analog (`eval-gates.ts`) instead of prod's `unity-tools/analyzer-gate.ts`.
 *
 * ── Decision matrix ─────────────────────────────────────────────────────
 * A pending write/edit skips the prompt (delegates immediately) iff:
 *   NOT (a serialized Unity asset path AND alwaysApproveUnityAssets !== false)
 *   AND (applyMode === 'auto' OR the session-allow flag is set)
 * Otherwise it renders an inline approval (`requestFileWriteApproval`,
 * `approval-gate.ts`) with three choices: Apply (once), Apply all this
 * session (sets the session-allow flag; cleared on `resetConversation`/a
 * freshly loaded session — see `resetWriteApprovalSession`), Reject. The
 * serialized-asset check runs FIRST and overrides both auto mode and an
 * already-set session-allow flag — by design: "apply all this session"
 * still stops at every scene/prefab/material write, deliberately, since
 * that's the one guarantee this feature exists to make unconditional.
 *
 * ── Computing the pending diff without writing ──────────────────────────
 * `write`: current on-disk content (or '' if missing) vs `params.content`.
 * `edit`: current on-disk content run through `applyEdits` — the SAME pure
 * function `vendor/tools/edit.ts` calls internally (imported, not
 * reimplemented, for exact parity with what a real edit produces) — against
 * `params.edits`. If `applyEdits` reports `applied: false` (the search text
 * doesn't match), there's nothing real to approve: the wrapped tool will
 * fail with the identical, deterministic error if we delegate to it (same
 * content, same edits), so we skip the prompt and let it return its own
 * error rather than asking the user to approve a change that can't happen.
 *
 * ── Composition & the "rejected writes must be inert" investigation ─────
 * Wiring (`agent-service.ts`): `withResultDiffs(wrapCs(withWriteApproval(
 * withCheckpoint(tool))))` — outer to inner: guard, diffs, the cs-gates
 * (analyzer/lsp/compile), THIS gate, checkpoint, the raw tool. Approval sits
 * OUTSIDE checkpoint (prompt first; snapshot only for writes that actually
 * proceed) and INSIDE the cs-gates (which post-process whatever result comes
 * back, real or rejected).
 *
 * On rejection this gate returns EARLY, never calling `tool.execute` at all —
 * which makes `withCheckpoint`'s pre-write snapshot AND the raw write/edit
 * tool's `onFileWritten`/`onFileEdited` (verified-pass's touched-file
 * registry) automatically inert: they simply never run. That leaves the
 * gates OUTSIDE this one (`wrapCs`: analyzer/lsp/compile) as the ones that
 * needed an explicit check, since they always run — they post-process
 * whatever result reaches them, not knowing whether a real write happened.
 * Investigation findings, gate by gate:
 *   - `lsp-gate.ts` was ALREADY incidentally inert: it only proceeds when
 *     `isSuccessfulWrite(res)` matches the literal "Successfully wrote/edited"
 *     prefix the vendor tools use, and this gate's rejection text doesn't.
 *     Given an explicit `isRejectedWrite` check anyway (defense in depth —
 *     the text-prefix convention shouldn't be the ONLY thing keeping it inert).
 *   - `analyzer-gate.ts` was NOT inert: its `write` branch reads
 *     `params.content` directly (not the disk) specifically so it can analyze
 *     newly-written content without a re-read — but that means a REJECTED
 *     write (nothing on disk changed) still got analyzed as if it had landed,
 *     misreporting the model's proposed-but-rejected content as "issues
 *     introduced by this C# write". Fixed with an early-out.
 *   - `compile-gate.ts` was NOT inert: it unconditionally triggers a real
 *     Unity recompile for any `.cs` path regardless of whether anything
 *     actually changed — wasteful (a pointless engine round-trip) and would
 *     burn one of the gate's own `MAX_ATTEMPTS` repair-iteration budget for a
 *     "fix" that was never applied. Fixed with an early-out.
 * The marker: `withWriteApproval`'s rejection result sets `rejected: true`
 * (not part of the vendor `AgentToolResult` shape — added here, not in
 * vendor/types.ts) and exports `isRejectedWrite` so the cs-gates can check it
 * cheaply instead of re-deriving "was this actually applied" from text.
 *
 * `diff-decorator.ts`'s `withResultDiffs` (outermost of all, per
 * `agent-service.ts`) needed no change: it reads the ACTUAL file before/after
 * delegating and only attaches `diffs` when those two reads differ. A
 * rejected write never touches disk, so both reads are identical and it
 * naturally attaches nothing — the same "no diffs" branch it already takes
 * for an ordinary tool-level failure.
 *
 * ── Bun-testability ──────────────────────────────────────────────────────
 * `requestApproval`'s default reaches `approval-gate.ts` via a DYNAMIC import
 * (mirrors `lsp-gate.ts`'s `defaultFetchDiagnostics`): `approval-gate.ts`
 * imports `stores/ai.ts`, which imports `stores/workspace.ts`, which imports
 * `features/editor` → `@monaco-editor/react` at module scope — a chain that
 * throws under Bun's DOM-less runtime (confirmed: `stores/theme.ts`'s
 * `document.documentElement` access blows up at import time). Deferring that
 * import means it's never reached in tests, which always inject a fake.
 * `useSettingsStore` (`stores/settings.ts`) has no such chain — confirmed
 * Bun-safe, same as `checkpoint-gate.ts` already relies on — so its default
 * getters import it directly, no dynamic-import needed.
 */

import { invoke } from '@tauri-apps/api/core';
import type { AgentTool, AgentToolResult } from './vendor/types';
import {
  resolveWithinRoot,
  PathOutsideRootError,
} from './vendor/tools/path-utils';
import { applyEdits, type Edit } from './vendor/tools/edit-diff';
import { useSettingsStore } from '../../../stores/settings';

export type WriteApprovalDecision = 'apply' | 'apply-all' | 'reject';

export interface PendingWriteDiff {
  path: string;
  oldText: string;
  newText: string;
}

/** `AgentToolResult` shape `withWriteApproval` can return, with the cheap rejection marker (see this module's header). */
export interface WriteApprovalResult extends AgentToolResult {
  /** Set (true) only on the "user rejected this write" result. Never set on a delegated/applied result. */
  rejected?: boolean;
}

/** True for the inert "user rejected this write" result — see this module's header for which gates need to check it. */
export function isRejectedWrite(res: AgentToolResult): boolean {
  return (res as WriteApprovalResult).rejected === true;
}

export interface WriteApprovalDeps {
  /** Reads the file's current content; resolves `null` if it doesn't exist (or is unreadable). */
  readFile: (absPath: string) => Promise<string | null>;
  /** Renders the inline approval + resolves once the user picks (or the signal aborts → reject). */
  requestApproval: (
    toolCallId: string,
    toolName: string,
    diff: PendingWriteDiff,
    signal?: AbortSignal,
  ) => Promise<WriteApprovalDecision>;
  /** `ai.edits.applyMode` setting lookup ('approve' default). */
  getApplyMode: () => 'approve' | 'auto';
  /** `ai.edits.alwaysApproveUnityAssets` setting lookup (true default). */
  getAlwaysApproveUnityAssets: () => boolean;
}

export interface WriteApprovalOptions {
  /**
   * The same Assets/ sandbox root the wrapped write/edit tool was created
   * with (null = no sandbox). Must match, or this gate prompts for paths the
   * inner tool will refuse to write.
   */
  allowedRoot?: string | null;
  deps?: WriteApprovalDeps;
}

/**
 * Serialized Unity asset extensions that always prompt, even in auto mode /
 * with the session-allow flag set. Duplicated locally rather than imported
 * from `unity-asset-viewer`'s `isUnityAssetFile` (same extension set):
 * `unity-asset-viewer` already imports FROM `ai-panel` (`SceneDiffViewer.tsx`
 * → `summarizeSceneDiff`), so importing the other way would create a
 * cross-feature cycle — `attachments.ts` made the same call for the same
 * reason (see its "Unity asset attachment" section header).
 *
 * Exported (T6) so `edit-review/review-registration.ts` can reuse the SAME
 * check for its own "does this path keep the pre-apply prompt instead of
 * entering post-hoc review" decision — that module must not carry a THIRD
 * copy of this extension list.
 */
const SERIALIZED_UNITY_ASSET_EXTS = ['.unity', '.prefab', '.asset', '.mat', '.controller', '.anim'];

export function isSerializedUnityAssetPath(path: string): boolean {
  const lower = path.toLowerCase();
  return SERIALIZED_UNITY_ASSET_EXTS.some((ext) => lower.endsWith(ext));
}

async function defaultReadFile(absPath: string): Promise<string | null> {
  return invoke<string>('read_file', { path: absPath }).catch(() => null);
}

async function defaultRequestApproval(
  toolCallId: string,
  toolName: string,
  diff: PendingWriteDiff,
  signal?: AbortSignal,
): Promise<WriteApprovalDecision> {
  const { requestFileWriteApproval } = await import('./approval-gate');
  return requestFileWriteApproval(toolCallId, toolName, diff, signal);
}

function defaultGetApplyMode(): 'approve' | 'auto' {
  return useSettingsStore.getState().getSetting('ai.edits.applyMode');
}

function defaultGetAlwaysApproveUnityAssets(): boolean {
  return useSettingsStore.getState().getSetting('ai.edits.alwaysApproveUnityAssets') !== false;
}

const DEFAULT_DEPS: WriteApprovalDeps = {
  readFile: defaultReadFile,
  requestApproval: defaultRequestApproval,
  getApplyMode: defaultGetApplyMode,
  getAlwaysApproveUnityAssets: defaultGetAlwaysApproveUnityAssets,
};

/**
 * "Apply all this session" — a single in-memory flag shared by every wrapped
 * write/edit tool for the lifetime of the conversation. Cleared by
 * `resetWriteApprovalSession()`, called from `resetConversation`/loading a
 * different session (`stores/ai.ts`) so the bypass never leaks across
 * conversations. Module-level singleton, same pattern as `approval-gate.ts`'s
 * `pending` map and `compile-gate.ts`'s per-file attempt counters.
 */
const sessionState = { allowed: false };

/** Reset the "Apply all this session" flag. Call on `resetConversation` / when a (different) session loads. */
export function resetWriteApprovalSession(): void {
  sessionState.allowed = false;
}

/** The inert "user rejected this write" result — also returned for an already-aborted signal (see `withWriteApproval`). */
function rejectedResult(absPath: string): WriteApprovalResult {
  return {
    content: [
      {
        type: 'text',
        text: `User rejected this edit to ${absPath}. Ask before retrying or take a different approach.`,
      },
    ],
    rejected: true,
  };
}

/** Compute the pending new content for a write/edit call without touching disk. `null` = no meaningful diff to show (see this module's header). */
async function computePendingNewText(
  tool: AgentTool,
  params: unknown,
  currentContent: string,
): Promise<string | null> {
  if (tool.name === 'write') {
    return (params as { content?: string }).content ?? '';
  }
  if (tool.name === 'edit') {
    const editInputs = ((params as { edits?: Edit[] }).edits ?? []) as Edit[];
    const result = applyEdits(currentContent, editInputs);
    return result.applied ? result.content : null;
  }
  return null;
}

/** Wrap a write/edit-shaped tool with the pre-apply approval gate. */
export function withWriteApproval(
  tool: AgentTool,
  cwd: string,
  options: WriteApprovalOptions = {},
): AgentTool {
  const deps = options.deps ?? DEFAULT_DEPS;
  const allowedRoot = options.allowedRoot ?? null;

  return {
    ...tool,
    async execute(id, params, signal, onUpdate) {
      const p = (params as { path?: string }).path;
      if (!p) return tool.execute(id, params, signal, onUpdate);

      let absPath: string;
      try {
        absPath = resolveWithinRoot(p, cwd, allowedRoot);
      } catch (err) {
        if (!(err instanceof PathOutsideRootError)) throw err;
        // Out-of-root: the inner tool will reject this write itself — don't
        // prompt for a write that can't happen.
        return tool.execute(id, params, signal, onUpdate);
      }

      const mustPrompt =
        deps.getAlwaysApproveUnityAssets() && isSerializedUnityAssetPath(absPath);
      const canSkipPrompt =
        !mustPrompt && (deps.getApplyMode() === 'auto' || sessionState.allowed);

      if (canSkipPrompt) return tool.execute(id, params, signal, onUpdate);

      const currentContent = (await deps.readFile(absPath)) ?? '';
      const newText = await computePendingNewText(tool, params, currentContent);
      if (newText === null) {
        // Can't compute a meaningful diff (e.g. the edit's search text won't
        // match the current content) — the wrapped tool will fail
        // deterministically with the same inputs, so let it run and surface
        // its own error instead of prompting over a change that can't happen.
        return tool.execute(id, params, signal, onUpdate);
      }

      // The reads/diff-compute above are genuinely async (real disk I/O in
      // production), so the signal can transition to aborted before we ever
      // reach the approval request. Checked here explicitly rather than
      // relying solely on the 'abort' event: a listener attached only once
      // `requestApproval` starts would never fire for a signal that was
      // ALREADY aborted by the time we get here, hanging the promise forever.
      // Also skips ever rendering a prompt for a turn that's already been cancelled.
      if (signal?.aborted) return rejectedResult(absPath);

      const decision = await deps.requestApproval(
        id,
        tool.name,
        { path: absPath, oldText: currentContent, newText },
        signal,
      );

      if (decision === 'apply-all') sessionState.allowed = true;

      if (decision === 'reject') return rejectedResult(absPath);

      return tool.execute(id, params, signal, onUpdate);
    },
  };
}
