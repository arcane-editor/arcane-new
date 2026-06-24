import type { Monaco } from '@monaco-editor/react';
import type { editor, IDisposable } from 'monaco-editor';
import { useUiStore } from '../../../stores/ui';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';
import { registerLocalCodeActionSource, type LocalCodeAction } from '../../lsp';
import type { DiagnosticItem } from '../../../types';
import type { SettingsSchema } from '../../../types';
import {
  scanCSharp,
  offsetToLineCol,
  type CSharpScan,
} from './csharp-scan';

// ── Public rule contract ─────────────────────────────────────────────────────

export type Severity = 'error' | 'warning' | 'info' | 'hint';

/** A quick-fix attached to a finding. Mirrors the lsp LocalCodeAction shape. */
export interface FindingFix {
  title: string;
  isPreferred?: boolean;
  /** LSP-shaped workspace edit (applied via the lsp applier). */
  edit?: LocalCodeAction['edit'];
  /** Or an arbitrary callback. */
  run?: () => void | Promise<void>;
}

/** One analyzer result. Offsets are 0-based into the scanned text. */
export interface Finding {
  ruleId: string;
  message: string;
  severity: Severity;
  /** 0-based start offset of the squiggle. */
  start: number;
  /** 0-based end offset (exclusive). */
  end: number;
  /** Short diagnostic code surfaced on the marker (e.g. `UNITY0001`). */
  code?: string;
  /** Quick-fixes offered for this finding. */
  fixes?: FindingFix[];
}

export interface RuleContext {
  /** The model being analysed (null when running headless via runAnalyzersOnText). */
  model: editor.ITextModel | null;
  /** Absolute file path of the document. */
  filePath: string;
  /** Detected Unity version string, or null. */
  unityVersion: string | null;
  monaco: Monaco | null;
}

export interface AnalyzerRule {
  id: string;
  defaultSeverity: Severity;
  /**
   * Settings sub-gate. When set, the rule only runs if this setting is true
   * (in addition to the master gate + isUnityProject).
   */
  settingKey?: keyof SettingsSchema;
  /** Produce findings for one scanned document. Must never throw. */
  run(scan: CSharpScan, ctx: RuleContext): Finding[];
}

// ── Rule registry ────────────────────────────────────────────────────────────

const rules: AnalyzerRule[] = [];

/** Register a rule with the engine. Idempotent per rule id. */
export function registerRule(rule: AnalyzerRule): void {
  if (rules.some((r) => r.id === rule.id)) return;
  rules.push(rule);
}

/** Introspection helper (used by tests / the AI gate). */
export function registeredRules(): readonly AnalyzerRule[] {
  return rules;
}

// ── Marker owner / source constants ──────────────────────────────────────────

export const MARKER_OWNER = 'unity-analyzer';
export const DIAGNOSTIC_SOURCE = 'unity-analyzer';

// ── Gating ───────────────────────────────────────────────────────────────────

function masterEnabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.analyzers.enabled') === true
  );
}

function ruleEnabled(rule: AnalyzerRule): boolean {
  if (rule.settingKey) {
    return useSettingsStore.getState().getSetting(rule.settingKey) === true;
  }
  return true;
}

// ── Core run ─────────────────────────────────────────────────────────────────

/**
 * Run every enabled rule over `text`. Pure: it does NOT touch Monaco or the
 * stores — it just returns findings. Exported for the AI analyzer-gate (T5.4)
 * to reuse the exact same rule set against arbitrary text. The master gate +
 * isUnityProject are checked by callers that publish; this function applies the
 * per-rule setting gates so a headless caller gets the same filtered set.
 */
export function runAnalyzersOnText(
  text: string,
  filePath: string,
  opts?: { unityVersion?: string | null; monaco?: Monaco | null; model?: editor.ITextModel | null },
): Finding[] {
  const scan = scanCSharp(text);
  const ctx: RuleContext = {
    model: opts?.model ?? null,
    filePath,
    unityVersion:
      opts?.unityVersion ?? useProjectContextStore.getState().unityVersion ?? null,
    monaco: opts?.monaco ?? null,
  };

  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!ruleEnabled(rule)) continue;
    try {
      findings.push(...rule.run(scan, ctx));
    } catch (err) {
      console.warn(`[unity-analyzers] rule '${rule.id}' threw (skipping):`, err);
    }
  }
  return findings;
}

// ── Finding → marker / diagnostic conversion ─────────────────────────────────

function severityToMarker(monaco: Monaco, sev: Severity): number {
  switch (sev) {
    case 'error': return monaco.MarkerSeverity.Error;
    case 'warning': return monaco.MarkerSeverity.Warning;
    case 'info': return monaco.MarkerSeverity.Info;
    case 'hint': return monaco.MarkerSeverity.Hint;
    default: return monaco.MarkerSeverity.Info;
  }
}

interface RangeSig {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

function findingToRange(scan: CSharpScan, f: Finding): RangeSig {
  const start = offsetToLineCol(scan.lineStarts, f.start);
  const end = offsetToLineCol(scan.lineStarts, f.end);
  return {
    startLineNumber: start.line,
    startColumn: start.col,
    endLineNumber: end.line,
    endColumn: end.col,
  };
}

// ── Pending-fix registry (powers the code-action source) ─────────────────────

interface PendingFix {
  range: RangeSig;
  fix: FindingFix;
}

// uri → list of pending fixes (keyed loosely by range; multiple per range OK).
const pendingFixes = new Map<string, PendingFix[]>();

function rangesOverlap(a: RangeSig, b: RangeSig): boolean {
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

// ── Publish path (Monaco markers + ui-store diagnostics) ─────────────────────

function publishForModel(monaco: Monaco, model: editor.ITextModel): void {
  const uri = model.uri.toString();
  const filePath = model.uri.fsPath ?? model.uri.path;
  const fileName = filePath.split('/').pop() || filePath;

  // Disabled / non-C# → clear everything we own for this uri.
  if (model.getLanguageId() !== 'csharp' || !masterEnabled()) {
    monaco.editor.setModelMarkers(model, MARKER_OWNER, []);
    useUiStore.getState().setFileDiagnostics(uri, DIAGNOSTIC_SOURCE, []);
    pendingFixes.delete(uri);
    return;
  }

  const text = model.getValue();
  const scan = scanCSharp(text);
  const ctx: RuleContext = {
    model,
    filePath,
    unityVersion: useProjectContextStore.getState().unityVersion ?? null,
    monaco,
  };

  const findings: Finding[] = [];
  for (const rule of rules) {
    if (!ruleEnabled(rule)) continue;
    try {
      findings.push(...rule.run(scan, ctx));
    } catch (err) {
      console.warn(`[unity-analyzers] rule '${rule.id}' threw (skipping):`, err);
    }
  }

  const markers: editor.IMarkerData[] = [];
  const items: DiagnosticItem[] = [];
  const fixes: PendingFix[] = [];

  for (const f of findings) {
    const range = findingToRange(scan, f);
    markers.push({
      severity: severityToMarker(monaco, f.severity),
      startLineNumber: range.startLineNumber,
      startColumn: range.startColumn,
      endLineNumber: range.endLineNumber,
      endColumn: range.endColumn,
      message: f.message,
      source: DIAGNOSTIC_SOURCE,
      code: f.code,
    });
    items.push({
      file: filePath,
      fileName,
      line: range.startLineNumber,
      col: range.startColumn,
      message: f.message,
      severity: f.severity,
      source: DIAGNOSTIC_SOURCE,
    });
    for (const fix of f.fixes ?? []) {
      fixes.push({ range, fix });
    }
  }

  monaco.editor.setModelMarkers(model, MARKER_OWNER, markers);
  useUiStore.getState().setFileDiagnostics(uri, DIAGNOSTIC_SOURCE, items);
  if (fixes.length > 0) pendingFixes.set(uri, fixes);
  else pendingFixes.delete(uri);
}

// ── Debounced model watcher + code-action source ─────────────────────────────

const DEBOUNCE_MS = 300;
const perUriDebounce = new Map<string, ReturnType<typeof setTimeout>>();
let createModelSub: IDisposable | null = null;
const contentSubs = new Map<string, IDisposable>();
let unregisterCodeActions: (() => void) | null = null;
let started = false;
let monacoRef: Monaco | null = null;

function schedule(monaco: Monaco, model: editor.ITextModel): void {
  const uri = model.uri.toString();
  const existing = perUriDebounce.get(uri);
  if (existing) clearTimeout(existing);
  perUriDebounce.set(
    uri,
    setTimeout(() => {
      perUriDebounce.delete(uri);
      if (model.isDisposed()) return;
      try {
        publishForModel(monaco, model);
      } catch (err) {
        console.warn('[unity-analyzers] publish failed:', err);
      }
    }, DEBOUNCE_MS),
  );
}

function watchModel(monaco: Monaco, model: editor.ITextModel): void {
  if (model.getLanguageId() !== 'csharp') return;
  const uri = model.uri.toString();
  if (contentSubs.has(uri)) return;

  // Initial run (small delay so we don't fight the first paint).
  schedule(monaco, model);

  const sub = model.onDidChangeContent(() => schedule(monaco, model));
  contentSubs.set(uri, sub);

  const disposeSub = model.onWillDispose(() => {
    const t = perUriDebounce.get(uri);
    if (t) {
      clearTimeout(t);
      perUriDebounce.delete(uri);
    }
    contentSubs.get(uri)?.dispose();
    contentSubs.delete(uri);
    disposeSub.dispose();
    sub.dispose();
    pendingFixes.delete(uri);
    // Clear store items for the gone model.
    useUiStore.getState().setFileDiagnostics(uri, DIAGNOSTIC_SOURCE, []);
  });
}

/**
 * Start the engine's Monaco wiring: watch C# models for changes, register the
 * quick-fix source. Idempotent. The publish path self-gates on master setting +
 * isUnityProject, so calling this in a non-Unity project is inert (it clears,
 * never adds). Returns a disposer.
 */
export function startEngine(monaco: Monaco): () => void {
  if (started) return stopEngine;
  started = true;
  monacoRef = monaco;

  for (const m of monaco.editor.getModels()) watchModel(monaco, m);
  createModelSub = monaco.editor.onDidCreateModel((m: editor.ITextModel) =>
    watchModel(monaco, m),
  );

  unregisterCodeActions = registerLocalCodeActionSource('csharp', (model, range) => {
    const list = pendingFixes.get(model.uri.toString());
    if (!list || list.length === 0) return [];
    const actions: LocalCodeAction[] = [];
    for (const { range: fixRange, fix } of list) {
      if (!rangesOverlap(range, fixRange)) continue;
      actions.push({
        title: fix.title,
        kind: 'quickfix',
        isPreferred: fix.isPreferred,
        edit: fix.edit,
        run: fix.run,
      });
    }
    return actions;
  });

  return stopEngine;
}

/** Re-run analysis for every watched C# model (e.g. after a setting toggles). */
export function refreshAll(monaco: Monaco): void {
  for (const m of monaco.editor.getModels()) {
    if (m.getLanguageId() === 'csharp') schedule(monaco, m);
  }
}

export function stopEngine(): void {
  for (const t of perUriDebounce.values()) clearTimeout(t);
  perUriDebounce.clear();
  for (const s of contentSubs.values()) s.dispose();
  contentSubs.clear();
  if (createModelSub) {
    createModelSub.dispose();
    createModelSub = null;
  }
  if (unregisterCodeActions) {
    unregisterCodeActions();
    unregisterCodeActions = null;
  }
  // Clear all published markers + diagnostics we own (every C# model, so we
  // also clear any whose pending-fix entry was already evicted).
  const ui = useUiStore.getState();
  if (monacoRef) {
    for (const m of monacoRef.editor.getModels()) {
      if (m.getLanguageId() === 'csharp') {
        monacoRef.editor.setModelMarkers(m, MARKER_OWNER, []);
        ui.setFileDiagnostics(m.uri.toString(), DIAGNOSTIC_SOURCE, []);
      }
    }
  }
  for (const uri of pendingFixes.keys()) {
    ui.setFileDiagnostics(uri, DIAGNOSTIC_SOURCE, []);
  }
  pendingFixes.clear();
  monacoRef = null;
  started = false;
}
