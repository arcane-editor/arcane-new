/**
 * Solution-wide analysis — errors and warnings in files you have never opened.
 *
 * The Problems panel used to show only what the per-document pull had fetched,
 * which meant a project could be full of compile errors and the panel would be
 * empty until you happened to open the offending file. Closing a file made its
 * errors disappear.
 *
 * csharp-ls 0.22 advertises `diagnosticProvider.workspaceDiagnostics: true`, so
 * this needs no Roslyn host of our own — it is a `workspace/diagnostic` request
 * routed into the same store the per-document path already writes to.
 *
 * Two rules keep the two paths from fighting:
 *  - open documents are skipped here, because the per-document pull re-runs on
 *    every keystroke and is strictly fresher;
 *  - both write under the `lsp` source, so a later per-document result for a
 *    file you open naturally supersedes the workspace snapshot.
 */

import type { DiagnosticItem } from '../../../types';
import { useUiStore } from '../../../stores/ui';
import { lspManager } from './manager';
import { getOpenDocumentUris, pathFromFileUri } from './document-sync';

/** Wire shape of one LSP `Diagnostic` (subset we consume). */
interface RawLspDiagnostic {
  range: { start: { line: number; character: number } };
  severity?: number;
  code?: number | string;
  message: string;
}

/** One document's slice of a `WorkspaceDiagnosticReport`. */
export interface RawWorkspaceReport {
  uri: string;
  kind?: 'full' | 'unchanged';
  resultId?: string;
  items?: RawLspDiagnostic[];
}

const SEVERITY: Record<number, DiagnosticItem['severity']> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

/**
 * Upper bound on files reported in one pass. A pathological project should
 * degrade to "most of the problems" rather than pinning the renderer; the
 * caller logs whenever this truncates, because a silent cap reads as
 * "your project is clean".
 */
export const MAX_REPORTED_FILES = 2000;

/**
 * Upper bound on diagnostics kept for ONE file.
 *
 * The file cap alone is not enough: a single generated or badly-broken file can
 * carry tens of thousands of diagnostics, and the Problems panel renders every
 * one. Past a few hundred the list is unreadable anyway, so the tail is dropped
 * rather than held in memory and sorted on every subsequent publish.
 */
export const MAX_ITEMS_PER_FILE = 500;

/** Pure — one document report to store items. */
export function toDiagnosticItems(
  uri: string,
  raw: RawLspDiagnostic[] | undefined,
): DiagnosticItem[] {
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const file = pathFromFileUri(uri);
  const fileName = file.split('/').pop() || '';
  // Errors first, so a truncated file keeps the diagnostics that matter rather
  // than whichever ones the server happened to emit first.
  const ordered =
    raw.length > MAX_ITEMS_PER_FILE
      ? [...raw].sort((a, b) => (a.severity ?? 3) - (b.severity ?? 3))
      : raw;
  return ordered.slice(0, MAX_ITEMS_PER_FILE).map((d) => ({
    file,
    fileName,
    line: d.range.start.line + 1,
    col: d.range.start.character + 1,
    message: d.message,
    severity: SEVERITY[d.severity ?? 3] ?? 'info',
    source: 'lsp' as const,
  }));
}

/**
 * Decide which reports to apply.
 *
 * `kind: 'unchanged'` means "same as the resultId you sent me" and carries no
 * items — applying it would wrongly clear that file. Open documents are left
 * to the per-document path.
 */
export function selectApplicableReports(
  reports: RawWorkspaceReport[],
  openUris: ReadonlySet<string>,
): RawWorkspaceReport[] {
  return reports.filter(
    (r) => !!r.uri && r.kind !== 'unchanged' && !openUris.has(r.uri),
  );
}

/** `resultId`s from the previous pass, so the server can answer 'unchanged'. */
const previousResultIds = new Map<string, string>();

export interface WorkspaceAnalysisResult {
  ran: boolean;
  /** Files whose diagnostics were written this pass. */
  filesReported: number;
  errors: number;
  warnings: number;
  /** True when MAX_REPORTED_FILES clipped the response. */
  truncated: boolean;
  /** Why it did not run, when `ran` is false. */
  reason?: string;
}

/**
 * Ask the C# server for diagnostics across the whole solution and route them
 * into the Problems panel.
 */
export async function runWorkspaceDiagnostics(): Promise<WorkspaceAnalysisResult> {
  const empty = { filesReported: 0, errors: 0, warnings: 0, truncated: false };
  const client = lspManager.client('csharp');
  if (!client.isRunning()) {
    return { ran: false, ...empty, reason: 'the C# language server is not running' };
  }

  const caps = client.getServerCapabilities() as {
    diagnosticProvider?: boolean | { workspaceDiagnostics?: boolean };
  } | null;
  const dp = caps?.diagnosticProvider;
  const supported = typeof dp === 'object' && dp !== null && dp.workspaceDiagnostics === true;
  if (!supported) {
    return {
      ran: false,
      ...empty,
      reason: 'this language server does not support workspace diagnostics',
    };
  }

  const previousResultIds_ = [...previousResultIds.entries()].map(([uri, value]) => ({
    uri,
    value,
  }));

  const res = await client.request<{ items?: RawWorkspaceReport[] } | null>(
    'workspace/diagnostic',
    { previousResultIds: previousResultIds_ },
  );

  const reports = Array.isArray(res?.items) ? res.items : [];

  // Prune ids for files the server no longer knows about. A full pass reports
  // every file it tracks (as `full` or `unchanged`), so anything absent here
  // has been deleted — without this the map grows for the life of the process,
  // one entry per file ever seen.
  if (reports.length > 0) {
    const seen = new Set(reports.map((r) => r.uri));
    for (const uri of [...previousResultIds.keys()]) {
      if (!seen.has(uri)) previousResultIds.delete(uri);
    }
  }
  const openUris = new Set(getOpenDocumentUris());
  const applicable = selectApplicableReports(reports, openUris);
  const truncated = applicable.length > MAX_REPORTED_FILES;
  const slice = truncated ? applicable.slice(0, MAX_REPORTED_FILES) : applicable;

  let errors = 0;
  let warnings = 0;
  // Collect first, publish once. Publishing per file makes the store's
  // count recomputation quadratic (it flattens and sorts the whole map on
  // every write) and fires one re-render per file — on a large solution that
  // is thousands of full-map sorts on the main thread.
  const batch: Array<{ fileUri: string; source: 'lsp'; items: DiagnosticItem[] }> = [];
  for (const report of slice) {
    if (report.resultId) previousResultIds.set(report.uri, report.resultId);
    const items = toDiagnosticItems(report.uri, report.items);
    for (const i of items) {
      if (i.severity === 'error') errors++;
      else if (i.severity === 'warning') warnings++;
    }
    batch.push({ fileUri: report.uri, source: 'lsp', items });
  }
  useUiStore.getState().setManyFileDiagnostics(batch);

  if (truncated) {
    console.warn(
      `[LSP] Workspace diagnostics truncated at ${MAX_REPORTED_FILES} of ${applicable.length} files.`,
    );
  }

  return { ran: true, filesReported: slice.length, errors, warnings, truncated };
}

/** Forget cached result ids (on server restart or workspace change). */
export function resetWorkspaceDiagnostics(): void {
  previousResultIds.clear();
}
