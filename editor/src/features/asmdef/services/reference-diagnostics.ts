import type { Monaco } from '@monaco-editor/react';
import type { editor, IDisposable, Uri } from 'monaco-editor';
import { invoke } from '@tauri-apps/api/core';
import {
  registerLocalCodeActionSource,
  type LocalCodeAction,
} from '../../lsp';
import { useUiStore } from '../../../stores/ui';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useAsmdefStore, type AsmdefNode } from '../../../stores/asmdef';
import type { DiagnosticItem } from '../../../types';

// ── What counts as a "missing type/namespace" marker ────────────────────────
//
// csharp-ls / Roslyn surface "type or namespace not found" as CS0246 (and the
// closely-related CS0234 "namespace does not exist in the namespace"). The LSP
// publishes these as Monaco markers under owner `'lsp'`. The exact `code` shape
// is server-dependent — Roslyn typically emits the bare numeric id (`"0246"`),
// but some servers prefix `CS`. We accept either form, and fall back to a
// message-text match so the feature still works if the code field is absent.
// NOTE: the precise `code` format needs a live csharp-ls to confirm; the
// message fallback makes us robust to that.
const LSP_MARKER_OWNER = 'lsp';
const MISSING_TYPE_CODES = new Set(['CS0246', '0246', 'CS0234', '0234']);
const MISSING_TYPE_MESSAGE_RE =
  /could not be found|are you missing a using directive or an assembly reference|does not exist in the namespace/i;

/** Pull the human code string out of a marker's `code` union. */
function markerCode(marker: editor.IMarker): string | undefined {
  const c = marker.code;
  if (c == null) return undefined;
  return typeof c === 'string' ? c : c.value;
}

function isMissingTypeMarker(marker: editor.IMarker): boolean {
  const code = markerCode(marker);
  if (code && MISSING_TYPE_CODES.has(code)) return true;
  // Fall back to message text when the code is missing/unexpected.
  if (!code && MISSING_TYPE_MESSAGE_RE.test(marker.message)) return true;
  // Even with a code, a positive message match is a safe secondary signal.
  return MISSING_TYPE_MESSAGE_RE.test(marker.message) && /\b0246\b|\b0234\b/.test(code ?? '');
}

/**
 * Extract the missing type/namespace identifier from a CS0246/CS0234 marker.
 * Prefer the first single-quoted token in the message (Roslyn always quotes
 * the offending name); fall back to the text Monaco highlighted.
 */
function extractMissingToken(
  marker: editor.IMarker,
  model: editor.ITextModel,
): string | null {
  const quoted = marker.message.match(/'([^']+)'/);
  if (quoted?.[1]) return quoted[1];
  const ranged = model
    .getValueInRange({
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
    })
    .trim();
  return ranged.length > 0 ? ranged : null;
}

// ── Candidate assembly matching (conservative, single-candidate only) ────────

/** Last path segment of the dotted token (`A.B.Foo` → `Foo`). */
function leafName(token: string): string {
  const parts = token.split('.').filter(Boolean);
  return parts[parts.length - 1] ?? token;
}

function tokenMatchesAssembly(token: string, node: AsmdefNode): boolean {
  const leaf = leafName(token).toLowerCase();
  const name = node.name.toLowerCase();
  const ns = (node.root_namespace ?? '').toLowerCase();
  if (!leaf) return false;
  // The assembly name or rootNamespace plausibly contains the missing token,
  // OR the token's namespace prefix lines up with the assembly's namespace.
  return (
    name.includes(leaf) ||
    (ns.length > 0 && (ns.includes(leaf) || token.toLowerCase().startsWith(ns)))
  );
}

interface ReferenceCandidate {
  token: string;
  /** Assembly that plausibly provides `token` and isn't yet referenced. */
  assembly: AsmdefNode;
  ownerName: string;
}

/**
 * For one missing token, find the unique unreferenced assembly that plausibly
 * provides it. Returns null unless there is EXACTLY one candidate — we keep
 * v1 conservative to avoid noisy/wrong suggestions.
 */
function findUniqueCandidate(
  token: string,
  ownerName: string,
  graph: AsmdefNode[],
): ReferenceCandidate | null {
  const owner = graph.find((n) => n.name === ownerName);
  if (!owner) return null;
  const alreadyReferenced = new Set(owner.references);

  const matches = graph.filter(
    (n) =>
      n.name !== ownerName &&
      !alreadyReferenced.has(n.name) &&
      tokenMatchesAssembly(token, n),
  );

  if (matches.length !== 1) return null; // 0 = unknown, >1 = ambiguous → stay silent
  return { token, assembly: matches[0], ownerName };
}

// ── Owner asmdef file discovery + edit ───────────────────────────────────────

interface FileEntry {
  name: string;
  path: string;
  is_dir: boolean;
}

/** Find the `.asmdef` file inside an assembly's root folder. */
async function findAsmdefFile(rootFolder: string): Promise<string | null> {
  try {
    const entries = await invoke<FileEntry[]>('read_directory', { path: rootFolder });
    const asmdef = entries.find(
      (e) => !e.is_dir && e.name.toLowerCase().endsWith('.asmdef'),
    );
    return asmdef?.path ?? null;
  } catch (err) {
    console.warn('[Asmdef] findAsmdefFile failed for', rootFolder, err);
    return null;
  }
}

/** Detect the indent unit (string of spaces/tabs) used by a JSON document. */
function detectIndent(json: string): string {
  const m = json.match(/\n([ \t]+)\S/);
  return m?.[1] ?? '    '; // default 4 spaces (Unity's own asmdef default)
}

/**
 * Add `assemblyName` to the owner asmdef's `references` array and write it back.
 * Re-serialises with the file's existing indentation so Unity re-imports it
 * cleanly without a noisy whitespace diff. This edits the raw asmdef JSON
 * directly (it's not an LSP-tracked document), per the task brief.
 */
async function addReference(ownerAsmdefPath: string, assemblyName: string): Promise<void> {
  const raw = await invoke<string>('read_file', { path: ownerAsmdefPath });
  let parsed: { references?: unknown; [k: string]: unknown };
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    console.error('[Asmdef] owner asmdef is not valid JSON:', ownerAsmdefPath, err);
    return;
  }

  const refs = Array.isArray(parsed.references)
    ? (parsed.references as string[]).slice()
    : [];
  if (refs.includes(assemblyName)) return; // already there — nothing to do
  refs.push(assemblyName);
  parsed.references = refs;

  const indent = detectIndent(raw);
  const trailingNewline = raw.endsWith('\n') ? '\n' : '';
  const next = JSON.stringify(parsed, null, indent) + trailingNewline;
  await invoke('write_file', { path: ownerAsmdefPath, contents: next });
}

// ── Diagnostic recompute for a single model ──────────────────────────────────

/** Per-uri set of "addReference" actions keyed by a range signature. */
interface PendingFix {
  token: string;
  assembly: string;
  ownerName: string;
  /** Root folder of the OWNER assembly's asmdef — the file we edit. */
  ownerRootFolder: string;
  range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number };
}

// uri → range-signature → pending fix, so the code-action source can answer
// lightbulb requests without re-running the whole graph match.
const pendingFixes = new Map<string, Map<string, PendingFix>>();

function rangeSig(r: PendingFix['range']): string {
  return `${r.startLineNumber}:${r.startColumn}:${r.endLineNumber}:${r.endColumn}`;
}

function diagnosticsEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.asmdef.diagnostics') === true
  );
}

/**
 * Recompute asmdef reference diagnostics for one C# model from its current LSP
 * markers. Publishes to the `'asmdef'` diagnostic source and records pending
 * quick-fixes. A no-op (and clears prior output) when disabled.
 */
async function recomputeForModel(monaco: Monaco, model: editor.ITextModel): Promise<void> {
  const uri = model.uri.toString();
  const filePath = model.uri.fsPath ?? model.uri.path;

  // Publish under the model's own URI string — identical to the key the LSP
  // pull path uses (`model.uri.toString()`), so asmdef items land in the same
  // ui-store bucket as this file's LSP diagnostics for the Problems panel.
  const publishUri = uri;

  if (model.getLanguageId() !== 'csharp' || !diagnosticsEnabled()) {
    pendingFixes.delete(uri);
    useUiStore.getState().setFileDiagnostics(publishUri, 'asmdef', []);
    return;
  }

  const markers = monaco.editor
    .getModelMarkers({ resource: model.uri, owner: LSP_MARKER_OWNER })
    .filter(isMissingTypeMarker);

  if (markers.length === 0) {
    pendingFixes.delete(uri);
    useUiStore.getState().setFileDiagnostics(publishUri, 'asmdef', []);
    return;
  }

  const ownerName = await useAsmdefStore.getState().getOwningAssembly(filePath);
  if (!ownerName) {
    pendingFixes.delete(uri);
    useUiStore.getState().setFileDiagnostics(publishUri, 'asmdef', []);
    return;
  }

  const graph = useAsmdefStore.getState().graph;
  // The owner must have an asmdef node for a fix to be possible (predefined
  // assemblies like Assembly-CSharp have no asmdef file to edit). findUniqueCandidate
  // already returns null when the owner isn't in the graph, so ownerNode is
  // guaranteed present wherever we create a fix below.
  const ownerNode = graph.find((n) => n.name === ownerName);
  const items: DiagnosticItem[] = [];
  const fixes = new Map<string, PendingFix>();
  const fileName = filePath.split('/').pop() ?? filePath;

  for (const marker of markers) {
    const token = extractMissingToken(marker, model);
    if (!token) continue;

    const candidate = findUniqueCandidate(token, ownerName, graph);
    if (!candidate) continue; // 0 or >1 plausible assemblies → stay quiet

    const range = {
      startLineNumber: marker.startLineNumber,
      startColumn: marker.startColumn,
      endLineNumber: marker.endLineNumber,
      endColumn: marker.endColumn,
    };

    items.push({
      file: filePath,
      fileName,
      line: marker.startLineNumber,
      col: marker.startColumn,
      message: `Type '${token}' may live in assembly '${candidate.assembly.name}', which is not referenced by '${ownerName}'. Add reference?`,
      severity: 'warning',
      source: 'asmdef',
    });

    fixes.set(rangeSig(range), {
      token,
      assembly: candidate.assembly.name,
      ownerName,
      ownerRootFolder: ownerNode?.root_folder ?? '',
      range,
    });
  }

  if (fixes.size > 0) pendingFixes.set(uri, fixes);
  else pendingFixes.delete(uri);
  useUiStore.getState().setFileDiagnostics(publishUri, 'asmdef', items);
}

// ── Marker-change watcher + code-action registration ─────────────────────────

const RECOMPUTE_DEBOUNCE_MS = 400;
let watcherDisposable: IDisposable | null = null;
let unregisterCodeActions: (() => void) | null = null;
const perUriDebounce = new Map<string, ReturnType<typeof setTimeout>>();

function scheduleRecompute(monaco: Monaco, model: editor.ITextModel): void {
  const uri = model.uri.toString();
  const existing = perUriDebounce.get(uri);
  if (existing) clearTimeout(existing);
  perUriDebounce.set(
    uri,
    setTimeout(() => {
      perUriDebounce.delete(uri);
      if (model.isDisposed()) return;
      void recomputeForModel(monaco, model);
    }, RECOMPUTE_DEBOUNCE_MS),
  );
}

function rangesOverlap(
  a: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
  b: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
): boolean {
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

/**
 * Start the CS0246 → asmdef-reference diagnostic watcher and register the
 * matching quick-fix source. Idempotent. Returns a disposer that tears both
 * down. Safe to call for non-Unity projects: the diagnostic recompute is gated
 * on `diagnosticsEnabled()`, so it produces nothing until a Unity project with
 * the setting enabled is active.
 */
export function startReferenceDiagnostics(monaco: Monaco): () => void {
  if (watcherDisposable || unregisterCodeActions) {
    return stopReferenceDiagnostics;
  }

  // React to LSP marker changes per affected URI.
  watcherDisposable = monaco.editor.onDidChangeMarkers((uris: readonly Uri[]) => {
    for (const uri of uris) {
      const model = monaco.editor.getModel(uri);
      if (model && model.getLanguageId() === 'csharp') {
        scheduleRecompute(monaco, model);
      }
    }
  });

  // Quick-fix: offer "Add '<Foo>' reference to <owner>.asmdef" for ranges where
  // we emitted an asmdef diagnostic.
  unregisterCodeActions = registerLocalCodeActionSource('csharp', (model, range) => {
    const fixes = pendingFixes.get(model.uri.toString());
    if (!fixes || fixes.size === 0) return [];

    const actions: LocalCodeAction[] = [];
    for (const fix of fixes.values()) {
      if (!rangesOverlap(range, fix.range)) continue;
      const ownerLabel = `${fix.ownerName}.asmdef`;
      actions.push({
        title: `Add '${fix.assembly}' reference to ${ownerLabel}`,
        kind: 'quickfix',
        isPreferred: true,
        run: async () => {
          const asmdefPath = await findAsmdefFile(fix.ownerRootFolder);
          if (!asmdefPath) {
            console.warn('[Asmdef] no owner .asmdef found in', fix.ownerRootFolder);
            return;
          }
          await addReference(asmdefPath, fix.assembly);
          // The file-watcher will also refresh the graph (debounced ~1s) when
          // it sees the asmdef write, but refresh inline too so the diagnostic
          // clears immediately: the owner now lists `fix.assembly` in its
          // references, so findUniqueCandidate no longer flags this token.
          const wp = useWorkspaceStore.getState().workspacePath;
          if (wp) await useAsmdefStore.getState().refresh(wp);
          void recomputeForModel(monaco, model);
        },
      });
    }
    return actions;
  });

  return stopReferenceDiagnostics;
}

export function stopReferenceDiagnostics(): void {
  if (watcherDisposable) {
    watcherDisposable.dispose();
    watcherDisposable = null;
  }
  if (unregisterCodeActions) {
    unregisterCodeActions();
    unregisterCodeActions = null;
  }
  for (const t of perUriDebounce.values()) clearTimeout(t);
  perUriDebounce.clear();
  // Clear any diagnostics we published. pendingFixes keys ARE the publish URIs
  // (model.uri.toString()), so we can clear them directly.
  const ui = useUiStore.getState();
  for (const uri of pendingFixes.keys()) {
    ui.setFileDiagnostics(uri, 'asmdef', []);
  }
  pendingFixes.clear();
}
