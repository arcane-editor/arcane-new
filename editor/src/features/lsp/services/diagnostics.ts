// One-shot C# diagnostics fetch (P3.3) — best-effort bridge between csharp-ls's
// PULL diagnostics (`textDocument/diagnostic`) and callers that need a
// diagnostics snapshot for a file that may NOT be open in Monaco (e.g. the AI
// agent just wrote/edited it on disk). Ephemerally opens the document if it
// isn't already tracked, pulls once, and closes it again — unless the file was
// already open (in which case we leave it open; closing a user's editor tab's
// backing document out from under them would break their live diagnostics).
//
// Consumed by the ai-panel's LSP diagnostics gate (`unity-tools/lsp-gate.ts`),
// which runs inside the agent's tool loop — so this must never hang or throw.
// A ~4s timeout and full try/catch coverage make every failure mode resolve to
// `[]` instead of blocking the loop or surfacing an error to the model.

import { fileUri, syncDocumentOpen, syncDocumentClose, getOpenDocumentUris } from './document-sync';
import { lspManager } from './manager';

/** Best-effort cap: never let a diagnostics fetch block the agent tool loop. */
const DIAGNOSTICS_TIMEOUT_MS = 4000;

/**
 * Small settle delay after the ephemeral `didOpen` before pulling. `didOpen`
 * goes out via `LspClient.notify`, which is fire-and-forget (doesn't await
 * its underlying `invoke`), so without this the pull request could reach the
 * server before the open does. Mirrors the 300ms initial-pull delay used for
 * newly-opened Monaco models in `providers.ts`.
 */
const OPEN_SETTLE_MS = 300;

export type FileDiagSeverity = 'error' | 'warning' | 'info' | 'hint';

export interface FileDiag {
  /** 1-based line number. */
  line: number;
  severity: FileDiagSeverity;
  message: string;
  code?: string;
}

/** Wire shape of one LSP `Diagnostic` (subset of fields we consume). */
interface RawLspDiagnostic {
  range: { start: { line: number; character: number } };
  severity?: number;
  code?: number | string;
  message: string;
}

interface RawDiagnosticReport {
  kind: 'full' | 'unchanged';
  resultId?: string;
  items?: RawLspDiagnostic[];
}

const SEVERITY_MAP: Record<number, FileDiagSeverity> = {
  1: 'error',
  2: 'warning',
  3: 'info',
  4: 'hint',
};

/** Pure — maps an LSP `DiagnosticSeverity` (1-4, default 3) to our string enum. */
export function mapLspSeverity(severity: number | undefined): FileDiagSeverity {
  return SEVERITY_MAP[severity ?? 3] ?? 'info';
}

/** Pure — maps one raw LSP diagnostic to a `FileDiag`. */
export function toFileDiag(raw: RawLspDiagnostic): FileDiag {
  return {
    line: raw.range.start.line + 1,
    severity: mapLspSeverity(raw.severity),
    message: raw.message,
    code: raw.code != null ? String(raw.code) : undefined,
  };
}

function delay<T>(ms: number, value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), ms));
}

/**
 * Fetch C# diagnostics for `absPath` with `content` as its current text,
 * whether or not the file is open in Monaco. Resolves to `[]` (never throws)
 * if csharp-ls isn't running, the request errors, or it doesn't answer within
 * `DIAGNOSTICS_TIMEOUT_MS`.
 */
export async function requestFileDiagnostics(absPath: string, content: string): Promise<FileDiag[]> {
  const client = lspManager.client('csharp');
  if (!client.isRunning()) return [];

  const uri = fileUri(absPath);
  const alreadyOpen = getOpenDocumentUris().has(uri);

  try {
    syncDocumentOpen(client, absPath, content, 'csharp');

    const pull = delay(OPEN_SETTLE_MS, undefined).then(() =>
      client
        .request<RawDiagnosticReport | null>('textDocument/diagnostic', {
          textDocument: { uri },
        })
        .catch(() => null),
    );

    const result = await Promise.race([pull, delay(DIAGNOSTICS_TIMEOUT_MS, null)]);

    if (!result || result.kind === 'unchanged') return [];
    return (result.items ?? []).map(toFileDiag);
  } catch {
    return [];
  } finally {
    if (!alreadyOpen) {
      syncDocumentClose(client, absPath);
    }
  }
}
