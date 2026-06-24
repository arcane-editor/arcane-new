// Unity compiler diagnostics — bridge the Unity Editor's compile output into the
// IDE's Problems panel + inline Monaco markers.
//
// Source of truth: the C# CompilationHook sends `compilation_finished` with a
// structured `messages: [{file,line,column,message,type}]` array (see the Rust
// router in unity_ipc.rs, which stamps `started:false` and forwards it). The
// `unity` store stashes that as `lastCompilation`. We subscribe to the store and
// republish those messages as `unity-compiler` diagnostics.
//
// Dedup vs the LSP is handled at read-time in the ui store
// (`getFlatDiagnosticsForUri` drops a `unity-compiler` item on a line that also
// has an `lsp` item — the LSP's version is richer). We just publish; the store
// keys by the same `file:///<abs>` Monaco URI the LSP/analyzer use so the dedup
// lines up.

import type { Monaco } from '@monaco-editor/react';
import type { editor, IDisposable } from 'monaco-editor';
import { useUnityStore } from '../../stores/unity';
import { useUiStore } from '../../stores/ui';
import { useProjectContextStore } from '../../stores/project-context';
import { useSettingsStore } from '../../stores/settings';
import { useWorkspaceStore } from '../../stores/workspace';
import type { CompilationPayload, CompilerMessage } from '../../types/unity';
import type { DiagnosticItem } from '../../types';

const MARKER_OWNER = 'unity-compiler';
const DIAGNOSTIC_SOURCE = 'unity-compiler';

let started = false;
let monacoRef: Monaco | null = null;
// uri → markers, retained so a model OPENED AFTER a compile finished still gets
// its squiggles (applied via onDidCreateModel). Also the set of uris we own.
const markersByUri = new Map<string, editor.IMarkerData[]>();
let unsubStore: (() => void) | null = null;
let createModelSub: IDisposable | null = null;

/** Compile feedback rides on the bridge; reuse its enable gate. */
function enabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.bridge.enabled') === true
  );
}

function basename(p: string): string {
  return p.replace(/\\/g, '/').split('/').pop() || p;
}

/** Resolve a Unity CompilerMessage.file (project-relative or absolute) → abs path. */
function toAbsPath(file: string): string | null {
  const norm = file.replace(/\\/g, '/');
  if (norm.startsWith('/') || /^[A-Za-z]:/.test(norm)) return norm;
  const ws = useWorkspaceStore.getState().workspacePath;
  if (!ws) return null;
  const prefix = ws.endsWith('/') ? ws : ws + '/';
  return prefix + norm.replace(/^\.?\//, '');
}

function clearAll(): void {
  const ui = useUiStore.getState();
  for (const uri of markersByUri.keys()) {
    ui.setFileDiagnostics(uri, DIAGNOSTIC_SOURCE, []);
    if (monacoRef) {
      const model = monacoRef.editor.getModel(monacoRef.Uri.parse(uri));
      if (model) monacoRef.editor.setModelMarkers(model, MARKER_OWNER, []);
    }
  }
  markersByUri.clear();
}

function publishReport(report: CompilationPayload): void {
  // Always clear the previous compile's diagnostics first.
  clearAll();
  if (!enabled() || !monacoRef) return;
  const messages = report.messages ?? [];
  if (messages.length === 0) return;

  // Group messages by absolute path.
  const byPath = new Map<string, CompilerMessage[]>();
  for (const m of messages) {
    const abs = toAbsPath(m.file);
    if (!abs) continue;
    const list = byPath.get(abs) ?? [];
    list.push(m);
    byPath.set(abs, list);
  }

  const ui = useUiStore.getState();
  for (const [abs, msgs] of byPath) {
    const uri = monacoRef.Uri.file(abs).toString();
    const fileName = basename(abs);
    const items: DiagnosticItem[] = [];
    const markers: editor.IMarkerData[] = [];
    for (const m of msgs) {
      const line = Math.max(1, m.line || 1);
      const col = Math.max(1, m.column || 1);
      const isError = m.type === 'Error';
      items.push({
        file: abs,
        fileName,
        line,
        col,
        message: m.message,
        severity: isError ? 'error' : 'warning',
        source: DIAGNOSTIC_SOURCE,
      });
      markers.push({
        severity: isError ? monacoRef.MarkerSeverity.Error : monacoRef.MarkerSeverity.Warning,
        startLineNumber: line,
        startColumn: col,
        endLineNumber: line,
        endColumn: col + 1,
        message: m.message,
        source: DIAGNOSTIC_SOURCE,
      });
    }
    ui.setFileDiagnostics(uri, DIAGNOSTIC_SOURCE, items);
    markersByUri.set(uri, markers);
    const model = monacoRef.editor.getModel(monacoRef.Uri.parse(uri));
    if (model) monacoRef.editor.setModelMarkers(model, MARKER_OWNER, markers);
  }
}

/**
 * Start mirroring Unity compile diagnostics into the Problems panel + inline
 * markers. Idempotent; self-gates on isUnityProject + the bridge setting (a
 * non-Unity project is inert). Returns a disposer.
 */
export function initUnityCompilerDiagnostics(monaco: Monaco): () => void {
  if (started) return disposeUnityCompilerDiagnostics;
  started = true;
  monacoRef = monaco;

  // A file opened AFTER the compile finished still needs its squiggles.
  createModelSub = monaco.editor.onDidCreateModel((model: editor.ITextModel) => {
    const markers = markersByUri.get(model.uri.toString());
    if (markers) monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  });

  unsubStore = useUnityStore.subscribe((state, prev) => {
    // Compile just started → clear stale diagnostics so the panel reflects the
    // in-progress build.
    if (state.isCompiling && !prev.isCompiling) clearAll();
    // A fresh finished report arrived → publish it.
    if (state.lastCompilation && state.lastCompilation !== prev.lastCompilation) {
      publishReport(state.lastCompilation);
    }
  });

  return disposeUnityCompilerDiagnostics;
}

export function disposeUnityCompilerDiagnostics(): void {
  if (unsubStore) {
    unsubStore();
    unsubStore = null;
  }
  if (createModelSub) {
    createModelSub.dispose();
    createModelSub = null;
  }
  clearAll();
  monacoRef = null;
  started = false;
}
