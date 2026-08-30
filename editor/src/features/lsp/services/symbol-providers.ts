/**
 * Symbol, navigation and formatting providers backed by the language server.
 *
 * Split out of `providers.ts` for the same reason `rename-provider.ts` and
 * `code-actions.ts` are: these carry their own mapping logic, and that logic is
 * the part worth testing. The `register*` functions are untestable without a
 * full Monaco stub, so every LSP→Monaco conversion below is an exported pure
 * function and the registration is a thin shell over it.
 *
 * csharp-ls 0.22 advertises `documentSymbolProvider`, `implementationProvider`,
 * `typeDefinitionProvider`, `documentFormattingProvider` and
 * `documentRangeFormattingProvider`. `verify:intellisense` asserts they are
 * still advertised, so a server downgrade fails CI rather than silently
 * removing Go-to-Symbol, the outline, or Format Document.
 */

import type { Monaco } from '@monaco-editor/react';
import type { editor, languages, Position } from 'monaco-editor';
import {
  getLspContextForModel,
  toMonacoRange,
  toLspRange,
  buildTextDocumentPositionParams,
  type LspRange,
} from './model-context';
import { LSP_BACKED_MONACO_LANGUAGES } from '../../../utils/language-detect';
import { lspManager } from './manager';
import { pathFromFileUri } from './document-sync';

// ── LSP shapes (structural, not imported) ───────────────────────

interface LspLocation {
  uri: string;
  range: LspRange;
}

interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

/** LSP 3.10+ hierarchical symbol. */
export interface LspDocumentSymbol {
  name: string;
  detail?: string;
  kind: number;
  deprecated?: boolean;
  range: LspRange;
  selectionRange: LspRange;
  children?: LspDocumentSymbol[];
}

/** The older flat shape. Servers may return either; csharp-ls returns this. */
export interface LspSymbolInformation {
  name: string;
  kind: number;
  containerName?: string;
  location: LspLocation;
}

export interface LspTextEdit {
  range: LspRange;
  newText: string;
}

export interface LspInlayHint {
  position: { line: number; character: number };
  /** LSP allows a string or an array of label parts. */
  label: string | Array<{ value: string }>;
  /** 1 = Type, 2 = Parameter. */
  kind?: number;
  paddingLeft?: boolean;
  paddingRight?: boolean;
}

// ── pure mappers ────────────────────────────────────────────────

/**
 * LSP `SymbolKind` (1-based, File=1) → Monaco `SymbolKind` (0-based, File=0).
 *
 * The two enums list the same 26 kinds in the same order, so the conversion is
 * a shift by one — but only for values actually in range. An out-of-range kind
 * maps to Monaco's `Variable` rather than producing a negative index, which
 * Monaco renders as a blank icon.
 */
export function toMonacoSymbolKind(lspKind: number): number {
  if (!Number.isInteger(lspKind) || lspKind < 1 || lspKind > 26) return 12; // Variable
  return lspKind - 1;
}

function isHierarchical(
  s: LspDocumentSymbol | LspSymbolInformation,
): s is LspDocumentSymbol {
  return (s as LspDocumentSymbol).selectionRange !== undefined;
}

/**
 * Convert either symbol shape into Monaco's `DocumentSymbol[]`.
 *
 * The flat `SymbolInformation` shape has no `selectionRange`, so the full range
 * is reused for both — Monaco requires `selectionRange` to be contained by
 * `range`, and a mismatch there makes the outline silently drop the entry.
 * `containerName` becomes `detail`, which is what the breadcrumb renders.
 */
export function lspSymbolsToMonaco(
  symbols: Array<LspDocumentSymbol | LspSymbolInformation> | null | undefined,
): languages.DocumentSymbol[] {
  if (!Array.isArray(symbols)) return [];
  return symbols.map((s) => {
    if (isHierarchical(s)) {
      return {
        name: s.name,
        detail: s.detail ?? '',
        kind: toMonacoSymbolKind(s.kind),
        tags: [],
        range: toMonacoRange(s.range),
        selectionRange: toMonacoRange(s.selectionRange),
        children: s.children ? lspSymbolsToMonaco(s.children) : undefined,
      } as languages.DocumentSymbol;
    }
    const range = toMonacoRange(s.location.range);
    return {
      name: s.name,
      detail: s.containerName ?? '',
      kind: toMonacoSymbolKind(s.kind),
      tags: [],
      range,
      selectionRange: range,
    } as languages.DocumentSymbol;
  });
}

/** LSP `TextEdit[]` → Monaco `TextEdit[]`. */
export function lspEditsToMonaco(
  edits: LspTextEdit[] | null | undefined,
): languages.TextEdit[] {
  if (!Array.isArray(edits)) return [];
  return edits.map((e) => ({ range: toMonacoRange(e.range), text: e.newText }));
}


/**
 * LSP inlay hints to Monaco's shape.
 *
 * The label may be a plain string or an array of parts (servers use the array
 * form to attach per-part tooltips and locations). Monaco wants a string here,
 * so the parts are joined — dropping the array case would silently render
 * nothing for every hint csharp-ls sends in that form.
 */
export function lspInlayHintsToMonaco(
  raw: LspInlayHint[] | null | undefined,
): languages.InlayHint[] {
  if (!Array.isArray(raw)) return [];
  return raw.map((h) => ({
    label: typeof h.label === 'string' ? h.label : h.label.map((p) => p.value).join(''),
    position: { lineNumber: h.position.line + 1, column: h.position.character + 1 },
    kind: h.kind === 1 ? 1 : 2,
    paddingLeft: h.paddingLeft,
    paddingRight: h.paddingRight,
  }));
}

// ── workspace symbols ───────────────────────────────────────────

/** One project-wide symbol, flattened for the command palette. */
export interface WorkspaceSymbolHit {
  name: string;
  /** Monaco `SymbolKind`, already converted. */
  kind: number;
  containerName: string;
  /** Absolute filesystem path, decoded from the LSP file URI. */
  path: string;
  /** 1-based, ready to hand to `setPendingNavigation`. */
  line: number;
  column: number;
}

/**
 * Map a raw `workspace/symbol` response into palette rows.
 *
 * Exported for testing: the request half needs a live server, the mapping half
 * is where the off-by-one and URI-decoding bugs live.
 */
export function toWorkspaceSymbolHits(
  raw: LspSymbolInformation[] | null | undefined,
  fromUri: (uri: string) => string | null,
): WorkspaceSymbolHit[] {
  if (!Array.isArray(raw)) return [];
  const hits: WorkspaceSymbolHit[] = [];
  for (const s of raw) {
    // A symbol whose URI cannot be turned back into a path is unopenable, so
    // it is dropped rather than rendered as a row that does nothing on Enter.
    const path = s.location?.uri ? fromUri(s.location.uri) : null;
    if (!path || !s.location?.range) continue;
    hits.push({
      name: s.name,
      kind: toMonacoSymbolKind(s.kind),
      containerName: s.containerName ?? '',
      path,
      line: s.location.range.start.line + 1,
      column: s.location.range.start.character + 1,
    });
  }
  return hits;
}

/**
 * Query every running language server for project-wide symbols.
 *
 * Monaco has no workspace-symbol provider in its standalone API, so this is
 * called directly from the command palette rather than registered — the same
 * arrangement `diagnostics.ts` uses for pull diagnostics.
 *
 * Servers are queried in parallel and one that fails is skipped, not fatal:
 * with C# and TypeScript both live in a Unity project, a csharp-ls that is
 * still loading the solution should not blank out the TS results.
 */
export const MIN_SYMBOL_QUERY_LENGTH = 2;

export async function queryWorkspaceSymbols(
  query: string,
  limit = 200,
): Promise<WorkspaceSymbolHit[]> {
  // LSP has no limit parameter, so the only lever on response size is the
  // query. A one-character query against a large solution asks the server to
  // materialise essentially every symbol it knows, which it then serialises
  // over stdio — seconds of work for a result the user cannot read anyway.
  const trimmed = query.trim();
  if (trimmed.length < MIN_SYMBOL_QUERY_LENGTH) return [];
  const clients = lspManager.all().filter((c) => c.isRunning());
  if (clients.length === 0) return [];

  const perServer = await Promise.all(
    clients.map(async (client) => {
      const caps = client.getServerCapabilities() as {
        workspaceSymbolProvider?: boolean | Record<string, unknown>;
      } | null;
      if (!caps?.workspaceSymbolProvider) return [];
      try {
        const raw = await client.request<LspSymbolInformation[] | null>(
          'workspace/symbol',
          { query: trimmed },
        );
        // Trim per server BEFORE merging, so one verbose server cannot crowd
        // every other server's results out of the shared budget.
        return toWorkspaceSymbolHits(raw, pathFromFileUri).slice(0, limit);
      } catch {
        return [];
      }
    }),
  );
  return perServer.flat().slice(0, limit);
}

// ── semantic tokens ─────────────────────────────────────────────

/**
 * The server's legend, read off its `initialize` capabilities.
 *
 * This is why semantic highlighting cannot be registered alongside the other
 * providers at startup: Monaco's `getLegend()` is synchronous and its result is
 * cached, but the legend only exists once a server has started and answered
 * `initialize`. Registering early with a guessed legend does not degrade to
 * "no colours" — it decodes every token index against the wrong table and
 * mis-colours the whole file, which is worse than leaving it off.
 */
export interface SemanticLegend {
  tokenTypes: string[];
  tokenModifiers: string[];
}

export function readSemanticLegend(
  caps: Record<string, unknown> | null,
): SemanticLegend | null {
  const provider = caps?.semanticTokensProvider as
    | { legend?: { tokenTypes?: unknown; tokenModifiers?: unknown } }
    | undefined;
  const legend = provider?.legend;
  if (!legend) return null;
  const tokenTypes = Array.isArray(legend.tokenTypes) ? legend.tokenTypes : null;
  if (!tokenTypes || tokenTypes.length === 0) return null;
  return {
    tokenTypes: tokenTypes.map(String),
    tokenModifiers: Array.isArray(legend.tokenModifiers)
      ? legend.tokenModifiers.map(String)
      : [],
  };
}

/** Live semantic-token registrations, keyed by Monaco language id. */
const semanticRegistrations = new Map<string, { dispose(): void }>();

/**
 * Register (or re-register) the semantic-tokens provider for one language,
 * using the legend the server actually advertised.
 *
 * Called from `attachClientToProviders`, i.e. once per server start — which is
 * exactly when the legend becomes knowable. Re-registering disposes the old
 * provider first so a restarted server with a different legend cannot leave a
 * stale decoder behind.
 */
export function registerSemanticTokensForClient(
  monaco: Monaco,
  languageId: string,
  caps: Record<string, unknown> | null,
  request: (method: string, params: unknown) => Promise<unknown>,
): void {
  const legend = readSemanticLegend(caps);
  semanticRegistrations.get(languageId)?.dispose();
  semanticRegistrations.delete(languageId);
  if (!legend) return;

  const registration = monaco.languages.registerDocumentSemanticTokensProvider(languageId, {
    getLegend: () => legend,
    async provideDocumentSemanticTokens(model: editor.ITextModel) {
      try {
        const res = (await request('textDocument/semanticTokens/full', {
          textDocument: { uri: model.uri.toString() },
        })) as { data?: number[]; resultId?: string } | null;
        if (!res?.data || !Array.isArray(res.data)) return null;
        // LSP and Monaco use the identical relative 5-tuple encoding
        // (deltaLine, deltaStartChar, length, tokenType, tokenModifiers),
        // so the payload passes straight through — only the container type
        // differs.
        return { data: new Uint32Array(res.data), resultId: res.resultId };
      } catch (err) {
        console.error('[LSP] SemanticTokens error:', err);
        return null;
      }
    },
    releaseDocumentSemanticTokens() {
      /* no server-side result cache to release — full requests only */
    },
  });
  semanticRegistrations.set(languageId, registration);

  // Range provider. csharp-ls advertises `full: true` as a bare boolean — NOT
  // `{ delta: true }` — so token deltas are unavailable and every edit re-sends
  // the whole document's tokens. `range` IS supported, and Monaco uses it to
  // paint the viewport, which bounds the work by screen size rather than file
  // size. That is the difference between a 10k-line file being usable or not.
  const rangeReg = monaco.languages.registerDocumentRangeSemanticTokensProvider(languageId, {
    getLegend: () => legend,
    async provideDocumentRangeSemanticTokens(
      model: editor.ITextModel,
      range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
    ) {
      try {
        const res = (await request('textDocument/semanticTokens/range', {
          textDocument: { uri: model.uri.toString() },
          range: toLspRange(range),
        })) as { data?: number[] } | null;
        if (!res?.data || !Array.isArray(res.data)) return null;
        return { data: new Uint32Array(res.data) };
      } catch (err) {
        console.error('[LSP] SemanticTokens(range) error:', err);
        return null;
      }
    },
  });
  const fullReg = registration;
  semanticRegistrations.set(languageId, {
    dispose: () => {
      fullReg.dispose();
      rangeReg.dispose();
    },
  });
}

/** Drop every semantic-token registration (used on full LSP teardown). */
export function disposeSemanticTokenProviders(): void {
  for (const reg of semanticRegistrations.values()) reg.dispose();
  semanticRegistrations.clear();
}

// ── registration ────────────────────────────────────────────────

function isLocationLink(loc: LspLocation | LspLocationLink): loc is LspLocationLink {
  return (loc as LspLocationLink).targetUri !== undefined;
}

/**
 * Shared body for `implementation` and `typeDefinition` — both answer with the
 * same `Location | Location[] | LocationLink[]` union that `definition` does.
 */
function locationsToMonaco(
  monaco: Monaco,
  result: LspLocation | LspLocation[] | LspLocationLink[] | null,
): languages.Location[] | null {
  if (!result || (Array.isArray(result) && result.length === 0)) return null;
  const arr = Array.isArray(result) ? result : [result];
  return arr.map((loc) =>
    isLocationLink(loc)
      ? {
          uri: monaco.Uri.parse(loc.targetUri),
          range: toMonacoRange(loc.targetSelectionRange ?? loc.targetRange),
        }
      : { uri: monaco.Uri.parse(loc.uri), range: toMonacoRange(loc.range) },
  );
}

/**
 * Register the symbol/navigation/formatting providers for every LSP-backed
 * language. Returns a dispose function, matching `registerLspRenameProviders`.
 */
export function registerLspSymbolProviders(monaco: Monaco): () => void {
  const disposables: Array<{ dispose(): void }> = [];

  for (const lang of LSP_BACKED_MONACO_LANGUAGES) {
    // ── DocumentSymbol → outline, breadcrumbs, Go to Symbol in file ──
    disposables.push(
      monaco.languages.registerDocumentSymbolProvider(lang, {
        displayName: 'LSP',
        async provideDocumentSymbols(model: editor.ITextModel) {
          const ctx = getLspContextForModel(model);
          if (!ctx) return null;
          try {
            const result = await ctx.client.request<
              Array<LspDocumentSymbol | LspSymbolInformation> | null
            >('textDocument/documentSymbol', {
              textDocument: { uri: model.uri.toString() },
            });
            return lspSymbolsToMonaco(result);
          } catch (err) {
            console.error('[LSP] DocumentSymbol error:', err);
            return null;
          }
        },
      }),
    );

    // ── Implementation ──────────────────────────────────────────
    disposables.push(
      monaco.languages.registerImplementationProvider(lang, {
        async provideImplementation(model: editor.ITextModel, position: Position) {
          const ctx = getLspContextForModel(model);
          if (!ctx) return null;
          try {
            const result = await ctx.client.request<
              LspLocation | LspLocation[] | LspLocationLink[] | null
            >('textDocument/implementation', buildTextDocumentPositionParams(model, position));
            return locationsToMonaco(monaco, result);
          } catch (err) {
            console.error('[LSP] Implementation error:', err);
            return null;
          }
        },
      }),
    );

    // ── TypeDefinition ──────────────────────────────────────────
    disposables.push(
      monaco.languages.registerTypeDefinitionProvider(lang, {
        async provideTypeDefinition(model: editor.ITextModel, position: Position) {
          const ctx = getLspContextForModel(model);
          if (!ctx) return null;
          try {
            const result = await ctx.client.request<
              LspLocation | LspLocation[] | LspLocationLink[] | null
            >('textDocument/typeDefinition', buildTextDocumentPositionParams(model, position));
            return locationsToMonaco(monaco, result);
          } catch (err) {
            console.error('[LSP] TypeDefinition error:', err);
            return null;
          }
        },
      }),
    );

    // ── Formatting ──────────────────────────────────────────────
    //
    // Until this existed, `editor.formatDocument` (shift+alt+f) dispatched an
    // event that no C# provider answered — the command was inert on every .cs
    // file in the product.
    disposables.push(
      monaco.languages.registerDocumentFormattingEditProvider(lang, {
        displayName: 'LSP',
        async provideDocumentFormattingEdits(
          model: editor.ITextModel,
          options: languages.FormattingOptions,
        ) {
          const ctx = getLspContextForModel(model);
          if (!ctx) return null;
          try {
            const result = await ctx.client.request<LspTextEdit[] | null>(
              'textDocument/formatting',
              {
                textDocument: { uri: model.uri.toString() },
                options: {
                  tabSize: options.tabSize,
                  insertSpaces: options.insertSpaces,
                },
              },
            );
            return lspEditsToMonaco(result);
          } catch (err) {
            console.error('[LSP] Formatting error:', err);
            return null;
          }
        },
      }),
    );

    // ── Inlay hints ─────────────────────────────────────────────
    // Parameter names and inferred types, rendered inline. csharp-ls serves
    // these; nothing was asking for them.
    disposables.push(
      monaco.languages.registerInlayHintsProvider(lang, {
        async provideInlayHints(
          model: editor.ITextModel,
          range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
        ) {
          const ctx = getLspContextForModel(model);
          if (!ctx) return null;
          try {
            const raw = await ctx.client.request<LspInlayHint[] | null>(
              'textDocument/inlayHint',
              { textDocument: { uri: model.uri.toString() }, range: toLspRange(range) },
            );
            const hints = lspInlayHintsToMonaco(raw);
            return { hints, dispose: () => {} };
          } catch (err) {
            console.error('[LSP] InlayHint error:', err);
            return null;
          }
        },
      }),
    );

    disposables.push(
      monaco.languages.registerDocumentRangeFormattingEditProvider(lang, {
        displayName: 'LSP',
        async provideDocumentRangeFormattingEdits(
          model: editor.ITextModel,
          range: { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
          options: languages.FormattingOptions,
        ) {
          const ctx = getLspContextForModel(model);
          if (!ctx) return null;
          try {
            const result = await ctx.client.request<LspTextEdit[] | null>(
              'textDocument/rangeFormatting',
              {
                textDocument: { uri: model.uri.toString() },
                range: toLspRange(range),
                options: {
                  tabSize: options.tabSize,
                  insertSpaces: options.insertSpaces,
                },
              },
            );
            return lspEditsToMonaco(result);
          } catch (err) {
            console.error('[LSP] Range formatting error:', err);
            return null;
          }
        },
      }),
    );
  }

  return () => {
    for (const d of disposables) d.dispose();
  };
}
