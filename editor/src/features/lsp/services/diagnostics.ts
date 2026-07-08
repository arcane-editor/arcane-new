// One-shot C# diagnostics fetch (P3.3) — best-effort bridge between csharp-ls's
// PULL diagnostics (`textDocument/diagnostic`) and callers that need a
// diagnostics snapshot for a file that may NOT be open in Monaco (e.g. the AI
// agent just wrote/edited it on disk). Always open/close-pairs its own
// ephemeral interest via `document-sync.ts`'s ref-counted open tracking: if
// the file is already open for another reason (a real editor tab, or another
// concurrent ephemeral fetch), our own `syncDocumentOpen`/`syncDocumentClose`
// only adjust the ref-count, so this call can never tear down someone else's
// open document out from under them — safe by construction, no snapshot of
// "was it already open" required (see the ref-count fix that replaced the
// prior `alreadyOpen`-snapshot approach, which had exactly that race: an
// ephemeral open that outlived a user opening the same file in a real tab
// during its settle window would close the tab's backing document on exit).
// The close also passes back the epoch `syncDocumentOpen` returned, so if an
// LSP crash/restart resync (`stores/workspace.ts`) races the fetch and calls
// `forgetDocument` mid-flight, this fetch's now-stale close is a no-op
// instead of sending a real `didClose` for a document the resync already
// re-opened under a new epoch (see `document-sync.ts`'s `forgetDocument`).
//
// Consumed by the ai-panel's LSP diagnostics gate (`unity-tools/lsp-gate.ts`),
// which runs inside the agent's tool loop — so this must never hang or throw.
// A ~4s timeout, an optional abort `signal`, and full try/catch coverage make
// every failure mode resolve to `[]` instead of blocking the loop or
// surfacing an error to the model.

import { fileUri, syncDocumentOpen, syncDocumentClose } from './document-sync';
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
 * Resolves to `null` the instant `signal` is (or becomes) aborted — whether
 * it was already aborted before this call or fires mid-flight. Used as an
 * extra `Promise.race` branch so an aborted tool call doesn't wait out the
 * settle delay / timeout.
 */
function abortSignal(signal: AbortSignal): Promise<null> {
  if (signal.aborted) return Promise.resolve(null);
  return new Promise((resolve) => {
    signal.addEventListener('abort', () => resolve(null), { once: true });
  });
}

/**
 * Fetch C# diagnostics for `absPath` with `content` as its current text,
 * whether or not the file is open in Monaco. Resolves to `[]` (never throws)
 * if csharp-ls isn't running, the request errors, it doesn't answer within
 * `DIAGNOSTICS_TIMEOUT_MS`, or `signal` is aborted. The ephemeral
 * open/close always runs as a matched pair regardless of outcome (including
 * abort) — see `finally` below — and is safe by construction because
 * `document-sync.ts` ref-counts opens.
 */
export async function requestFileDiagnostics(
  absPath: string,
  content: string,
  signal?: AbortSignal,
): Promise<FileDiag[]> {
  const client = lspManager.client('csharp');
  if (!client.isRunning()) return [];

  const uri = fileUri(absPath);

  let epoch: number | undefined;

  try {
    epoch = syncDocumentOpen(client, absPath, content, 'csharp');

    const pull = delay(OPEN_SETTLE_MS, undefined).then(() =>
      client
        .request<RawDiagnosticReport | null>('textDocument/diagnostic', {
          textDocument: { uri },
        })
        .catch(() => null),
    );

    const racers: Promise<RawDiagnosticReport | null>[] = [pull, delay(DIAGNOSTICS_TIMEOUT_MS, null)];
    if (signal) racers.push(abortSignal(signal));

    const result = await Promise.race(racers);

    if (!result || result.kind === 'unchanged') return [];
    return (result.items ?? []).map(toFileDiag);
  } catch {
    return [];
  } finally {
    syncDocumentClose(client, absPath, epoch);
  }
}
