import type { Monaco } from '@monaco-editor/react';
import type { editor, languages } from 'monaco-editor';
import { lspManager } from './manager';
import {
  getLspContextForModel,
  toLspRange,
  toMonacoRange,
  type LspRange,
} from './model-context';
import {
  applyLspWorkspaceEdit,
  type LspWorkspaceEdit,
} from './workspace-edit';
import {
  LSP_BACKED_MONACO_LANGUAGES,
} from '../../../utils/language-detect';

// ── LSP code-action types (structural, not imported) ────────────

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

interface LspCommand {
  title: string;
  command: string;
  arguments?: unknown[];
}

interface LspCodeAction {
  title: string;
  kind?: string;
  diagnostics?: LspDiagnostic[];
  isPreferred?: boolean;
  disabled?: { reason: string };
  edit?: LspWorkspaceEdit;
  command?: LspCommand;
  data?: unknown;
}

// ── Local (non-LSP) quick-fix source registry ───────────────────

/**
 * Minimal Monaco-compatible code-action shape local sources return.
 * `edit` (when present) is an LSP WorkspaceEdit — the provider routes
 * it through `applyLspWorkspaceEdit` exactly like server actions.
 */
export interface LocalCodeAction {
  title: string;
  kind?: string;
  isPreferred?: boolean;
  disabled?: string;
  /** LSP-shaped workspace edit, applied via applyLspWorkspaceEdit. */
  edit?: LspWorkspaceEdit;
  /** Arbitrary callback run when the user picks the action. */
  run?: () => void | Promise<void>;
}

export interface LocalCodeActionContext {
  /** Markers overlapping the requested range (Monaco 1-based). */
  markers: editor.IMarkerData[];
  /** Requested code-action kind filter, if any. */
  only?: string;
}

export type LocalCodeActionSource = (
  model: editor.ITextModel,
  range: Range1Based,
  context: LocalCodeActionContext,
) => LocalCodeAction[] | Promise<LocalCodeAction[]>;

interface Range1Based {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

const localSources = new Map<string, Set<LocalCodeActionSource>>();

/**
 * Register a local (non-LSP) quick-fix source for a Monaco language id.
 * Sources are merged with LSP actions on every lightbulb request.
 * Returns an unregister function. (Unity analyzers and asmdef quick
 * fixes plug in here.)
 */
export function registerLocalCodeActionSource(
  languageId: string,
  source: LocalCodeActionSource,
): () => void {
  let set = localSources.get(languageId);
  if (!set) {
    set = new Set();
    localSources.set(languageId, set);
  }
  set.add(source);
  return () => {
    set!.delete(source);
    if (set!.size === 0) localSources.delete(languageId);
  };
}

// ── Marker ↔ LSP diagnostic conversion ──────────────────────────

function markerSeverityToLsp(severity: number): number {
  // Monaco MarkerSeverity: Error=8, Warning=4, Info=2, Hint=1
  switch (severity) {
    case 8: return 1; // Error
    case 4: return 2; // Warning
    case 2: return 3; // Information
    case 1: return 4; // Hint
    default: return 3;
  }
}

function markerToLspDiagnostic(marker: editor.IMarkerData): LspDiagnostic {
  const code =
    typeof marker.code === 'object' && marker.code !== null
      ? (marker.code as { value: string }).value
      : marker.code;
  return {
    range: {
      start: { line: marker.startLineNumber - 1, character: marker.startColumn - 1 },
      end: { line: marker.endLineNumber - 1, character: marker.endColumn - 1 },
    },
    severity: markerSeverityToLsp(marker.severity),
    ...(code != null ? { code } : {}),
    ...(marker.source ? { source: marker.source } : {}),
    message: marker.message,
  };
}

function rangesOverlap(a: Range1Based, b: Range1Based): boolean {
  if (
    a.endLineNumber < b.startLineNumber ||
    (a.endLineNumber === b.startLineNumber && a.endColumn < b.startColumn)
  ) {
    return false;
  }
  if (
    b.endLineNumber < a.startLineNumber ||
    (b.endLineNumber === a.startLineNumber && b.endColumn < a.startColumn)
  ) {
    return false;
  }
  return true;
}

// ── LSP request plumbing ────────────────────────────────────────

/**
 * Lightbulb requests must never hang on a slow server (csharp-ls can
 * stall for minutes while loading a solution; the client's own timeout
 * is 180s). Race the request against a short deadline and fall back to
 * local-only actions.
 */
const CODE_ACTION_TIMEOUT_MS = 2_500;

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(null);
      },
    );
  });
}

/** A bare LSP Command (no literal CodeAction wrapper). */
function isBareCommand(item: LspCodeAction | LspCommand): item is LspCommand {
  return typeof (item as LspCommand).command === 'string';
}

/**
 * Execute a (possibly lazy) LSP code action:
 *  1. If it has no edit but might resolve to one, try `codeAction/resolve`.
 *  2. Apply the WorkspaceEdit through our applier (works for closed files
 *     too — Monaco's standalone edit service only handles open models).
 *  3. If it carries a server command, forward via `workspace/executeCommand`.
 */
async function executeLspCodeAction(action: LspCodeAction, serverKey: string): Promise<void> {
  const client = lspManager.client(serverKey);
  let resolved = action;

  if (!resolved.edit && resolved.data !== undefined && client.isRunning()) {
    try {
      const r = await client.request<LspCodeAction | null>('codeAction/resolve', resolved);
      if (r) resolved = r;
    } catch (err) {
      console.warn('[LSP] codeAction/resolve failed:', err);
    }
  }

  if (resolved.edit) {
    await applyLspWorkspaceEdit(resolved.edit);
  }

  if (resolved.command) {
    if (!client.isRunning()) return;
    try {
      await client.request('workspace/executeCommand', {
        command: resolved.command.command,
        arguments: resolved.command.arguments ?? [],
      });
    } catch (err) {
      console.error('[LSP] workspace/executeCommand failed:', err);
    }
  }
}

// ── Provider registration ───────────────────────────────────────

const APPLY_LSP_ACTION_COMMAND = 'editor.lsp.applyCodeAction';
const RUN_LOCAL_ACTION_COMMAND = 'editor.lsp.runLocalCodeAction';

/**
 * Register the LSP-backed CodeActionProvider (plus the apply commands it
 * relies on) for every LSP language. Called from `registerLspProviders`
 * so registration/disposal stays in one place. Returns a dispose fn.
 *
 * Monaco's standalone editor can only apply `{edit}` returned on a code
 * action to models that are open, so actions are returned with a custom
 * `command` instead; the command routes the LSP WorkspaceEdit through
 * `applyLspWorkspaceEdit`, which also handles closed files.
 */
export function registerLspCodeActionProviders(monaco: Monaco): () => void {
  const disposables: Array<{ dispose(): void }> = [];

  disposables.push(
    monaco.editor.registerCommand(
      APPLY_LSP_ACTION_COMMAND,
      (_accessor: unknown, action: LspCodeAction, serverKey: string) => {
        executeLspCodeAction(action, serverKey).catch((err) => {
          console.error('[LSP] Failed to apply code action:', err);
        });
      },
    ),
  );

  disposables.push(
    monaco.editor.registerCommand(
      RUN_LOCAL_ACTION_COMMAND,
      (_accessor: unknown, action: LocalCodeAction) => {
        Promise.resolve()
          .then(async () => {
            if (action.edit) await applyLspWorkspaceEdit(action.edit);
            if (action.run) await action.run();
          })
          .catch((err) => {
            console.error('[LSP] Failed to run local code action:', err);
          });
      },
    ),
  );

  const provider: languages.CodeActionProvider = {
    async provideCodeActions(
      model: editor.ITextModel,
      range: Range1Based,
      context: languages.CodeActionContext,
    ) {
      // Markers overlapping the requested range (rebuilt from the global
      // marker store so we capture every source, not just what Monaco
      // pre-filtered into context.markers).
      const overlappingMarkers = monaco.editor
        .getModelMarkers({ resource: model.uri })
        .filter((m: editor.IMarker) => rangesOverlap(m, range));

      const [lspActions, localActions] = await Promise.all([
        fetchLspActions(model, range, context, overlappingMarkers),
        fetchLocalActions(model, range, context, overlappingMarkers),
      ]);

      return {
        actions: [...lspActions, ...localActions],
        dispose() {},
      };
    },
  };

  for (const lang of LSP_BACKED_MONACO_LANGUAGES) {
    disposables.push(monaco.languages.registerCodeActionProvider(lang, provider));
  }

  async function fetchLspActions(
    model: editor.ITextModel,
    range: Range1Based,
    context: languages.CodeActionContext,
    overlappingMarkers: editor.IMarker[],
  ): Promise<languages.CodeAction[]> {
    const ctx = getLspContextForModel(model);
    if (!ctx) return [];

    const params = {
      textDocument: { uri: model.uri.toString() },
      range: toLspRange(range),
      context: {
        diagnostics: overlappingMarkers.map(markerToLspDiagnostic),
        ...(context.only ? { only: [context.only] } : {}),
      },
    };

    // Never block the lightbulb: a slow/failed server yields [] and the
    // local actions still show.
    const result = await withTimeout(
      ctx.client.request<Array<LspCodeAction | LspCommand> | null>(
        'textDocument/codeAction',
        params,
      ),
      CODE_ACTION_TIMEOUT_MS,
    );
    if (!result) return [];

    const serverKey = ctx.client.languageId;
    const actions: languages.CodeAction[] = [];

    for (const item of result) {
      // Normalise a bare Command into a CodeAction literal.
      const action: LspCodeAction = isBareCommand(item)
        ? { title: item.title, command: item }
        : item;

      const diagnostics = (action.diagnostics ?? []).map((d) => ({
        severity:
          d.severity === 1
            ? monaco.MarkerSeverity.Error
            : d.severity === 2
              ? monaco.MarkerSeverity.Warning
              : d.severity === 4
                ? monaco.MarkerSeverity.Hint
                : monaco.MarkerSeverity.Info,
        message: d.message,
        source: d.source,
        code: d.code != null ? String(d.code) : undefined,
        ...toMonacoRange(d.range),
      }));

      actions.push({
        title: action.title,
        kind: action.kind,
        diagnostics,
        isPreferred: action.isPreferred,
        disabled: action.disabled?.reason,
        // Apply through our applier (see module doc) instead of
        // returning `edit` to Monaco.
        command: {
          id: APPLY_LSP_ACTION_COMMAND,
          title: action.title,
          arguments: [action, serverKey],
        },
      });
    }

    return actions;
  }

  async function fetchLocalActions(
    model: editor.ITextModel,
    range: Range1Based,
    context: languages.CodeActionContext,
    overlappingMarkers: editor.IMarker[],
  ): Promise<languages.CodeAction[]> {
    const sources = localSources.get(model.getLanguageId());
    if (!sources || sources.size === 0) return [];

    const localCtx: LocalCodeActionContext = {
      markers: overlappingMarkers,
      only: context.only,
    };

    const actions: languages.CodeAction[] = [];
    for (const source of sources) {
      try {
        const produced = await source(model, range, localCtx);
        for (const action of produced) {
          actions.push({
            title: action.title,
            kind: action.kind ?? 'quickfix',
            isPreferred: action.isPreferred,
            disabled: action.disabled,
            command: {
              id: RUN_LOCAL_ACTION_COMMAND,
              title: action.title,
              arguments: [action],
            },
          });
        }
      } catch (err) {
        console.warn('[LSP] Local code-action source failed:', err);
      }
    }
    return actions;
  }

  return () => {
    for (const d of disposables) d.dispose();
  };
}
