import type { Monaco } from '@monaco-editor/react';
import type { editor, Position } from 'monaco-editor';
import type { LspClient } from './client';
import {
  getLspContextForModel,
  toMonacoRange,
  buildTextDocumentPositionParams,
  type LspRange,
} from './model-context';
import { registerApplyEditHandler } from './workspace-edit';
import { registerLspCodeActionProviders } from './code-actions';
import { registerLspRenameProviders } from './rename-provider';
import { useWorkspaceStore } from '../../../stores/workspace';
import { useUiStore } from '../../../stores/ui';
import { useProjectContextStore } from '../../../stores/project-context';
import { useSettingsStore } from '../../../stores/settings';
import { UNITY_LIFECYCLE_METHODS } from '../data/unity-lifecycle-snippets';
import { CSHARP_KEYWORDS } from '../data/csharp-keywords';
import { UNITY_API_NAMES } from '../data/unity-api-names';
import { getOpenDocumentUris, pathFromFileUri, syncDocumentOpen } from './document-sync';
import { lspManager } from './manager';
import { isCsharpProjectLoaded, onCsharpProjectLoaded } from './project-readiness';
import { LSP_BACKED_MONACO_LANGUAGES } from '../../../utils/language-detect';
import { setPendingNavigation } from '../../../utils/editor-navigation';

// ── LSP type aliases (structural, not imported) ─────────────────
// LspPosition/LspRange come from ./model-context (canonical home).

interface LspLocation {
  uri: string;
  range: LspRange;
}

/**
 * LSP 3.14+ richer alternative to `Location` — typescript-language-server
 * always returns these for definition/typeDefinition/implementation. Lets
 * the editor highlight the origin token and land the cursor on the target
 * symbol's name (rather than the start of the whole declaration body).
 */
interface LspLocationLink {
  originSelectionRange?: LspRange;
  targetUri: string;
  targetRange: LspRange;
  targetSelectionRange: LspRange;
}

function isLocationLink(loc: LspLocation | LspLocationLink): loc is LspLocationLink {
  return (loc as LspLocationLink).targetUri !== undefined;
}

interface LspCompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  insertTextFormat?: number; // 1 = PlainText, 2 = Snippet
  textEdit?:
    | { range: LspRange; newText: string }
    | { insert: LspRange; replace: LspRange; newText: string };
}

interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
}

interface LspHover {
  contents:
    | string
    | { kind: string; value: string }
    | Array<string | { kind: string; value: string }>;
  range?: LspRange;
}

interface LspSignatureHelp {
  signatures: Array<{
    label: string;
    documentation?: string | { kind: string; value: string };
    parameters?: Array<{
      label: string | [number, number];
      documentation?: string | { kind: string; value: string };
    }>;
    activeParameter?: number;
  }>;
  activeSignature?: number;
  activeParameter?: number;
}

interface LspDiagnostic {
  range: LspRange;
  severity?: number;
  code?: number | string;
  source?: string;
  message: string;
}

interface LspPublishDiagnosticsParams {
  uri: string;
  diagnostics: LspDiagnostic[];
}

// ── Helpers ─────────────────────────────────────────────────────
// LSP↔Monaco range/position conversion and per-model client lookup
// live in ./model-context (shared with code-actions.ts and
// rename-provider.ts). The rename provider + its post-processor
// registry live in ./rename-provider.

// ── CompletionItemKind mapping ──────────────────────────────────

function mapCompletionItemKind(
  lspKind: number | undefined,
  monacoLanguages: Monaco['languages'],
): number {
  const K = monacoLanguages.CompletionItemKind;

  const map: Record<number, number> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
    6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
    11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
    16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
    21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
  };

  return lspKind != null && map[lspKind] != null ? map[lspKind] : K.Text;
}

// ── Provider registration ───────────────────────────────────────

/**
 * Monaco language ids that get LSP-backed providers (completion, hover, etc.).
 * `typescript-language-server` serves both `.ts` and `.js` so both monaco
 * languages are listed.
 */
const TARGET_LANGUAGES: readonly string[] = LSP_BACKED_MONACO_LANGUAGES;

/**
 * Languages that get the Unity-specific providers (lifecycle snippets,
 * Unity API names, C# keywords). Hard-gated to C# only — these must
 * never appear inside `.py`/`.ts` files.
 */
const UNITY_ONLY_LANGUAGES: readonly string[] = ['csharp'];

function toLspCompletionTriggerKind(monacoTriggerKind: number): 1 | 2 | 3 {
  // Monaco: 0=Invoke, 1=TriggerCharacter, 2=TriggerForIncompleteCompletions
  // LSP:    1=Invoked, 2=TriggerCharacter, 3=TriggerForIncompleteCompletions
  switch (monacoTriggerKind) {
    case 1:
      return 2;
    case 2:
      return 3;
    default:
      return 1;
  }
}

/**
 * Register Monaco language providers (completion, hover, …) for every
 * supported language. Each provider looks up the right `LspClient` per
 * request via `lspManager`, so this can be called once at workspace load
 * regardless of which language servers are running yet.
 *
 * Returns a dispose function that tears down every registration.
 *
 * Note: this only registers the **Monaco-side** static providers. For
 * each `LspClient` you start, also call `attachClientToProviders` to
 * wire up that server's push-diagnostics notifications.
 */
export function registerLspProviders(monaco: Monaco): () => void {
  const disposables: Array<{ dispose(): void }> = [];
  console.info('[LSP] Registering Monaco LSP providers', { languages: TARGET_LANGUAGES });

  function registerForLanguages<T>(
    languages: readonly string[],
    registerFn: (languageId: string, provider: T) => { dispose(): void },
    provider: T,
  ) {
    for (const lang of languages) {
      console.info('[LSP] Registering provider for language', { lang });
      disposables.push(registerFn(lang, provider));
    }
  }

  let observedLspActivity = false;
  function markLspReadyFromActivity(): void {
    if (observedLspActivity) return;
    observedLspActivity = true;

    const ui = useUiStore.getState();
    if (ui.lspStatus === 'starting' || ui.lspStatus === 'indexing') {
      ui.setLspStatus('ready');
    }
  }

  // ── a) CompletionItemProvider ─────────────────────────────────
  registerForLanguages(
    TARGET_LANGUAGES,
    (lang, p) => monaco.languages.registerCompletionItemProvider(lang, p),
    {
      triggerCharacters: ['.', '<'],

      async provideCompletionItems(
        model: editor.ITextModel,
        position: Position,
        completionContext?: { triggerKind: number; triggerCharacter?: string },
      ) {
        const ctx = getLspContextForModel(model);
        if (!ctx) return { suggestions: [] };
        const { client, lspLanguageId } = ctx;

        const modelUri = model.uri.toString();
        const openSet = getOpenDocumentUris();
        const inOpenSet = openSet.has(modelUri);

        console.info('[LSP] completion model URI', {
          modelUri,
          modelPath: model.uri.path,
          inOpenSet,
          languageId: lspLanguageId,
          openSetSample: [...openSet].slice(0, 3),
        });

        // Defensive recovery: if Monaco's URI isn't in our didOpen set
        // (race condition or URI normalization mismatch), open it now so
        // the LSP server knows about the document before the request.
        if (!inOpenSet && modelUri.startsWith('file://')) {
          try {
            const filePath = decodeURIComponent(modelUri.replace(/^file:\/\//, ''));
            console.warn('[LSP] Defensive didOpen — model URI not in open set', {
              modelUri,
              filePath,
              languageId: lspLanguageId,
            });
            syncDocumentOpen(client, filePath, model.getValue(), lspLanguageId);
          } catch (err) {
            console.warn('[LSP] Defensive didOpen failed:', err);
          }
        }

        try {
          const params = {
            ...buildTextDocumentPositionParams(model, position),
            ...(completionContext
              ? {
                  context: {
                    triggerKind: toLspCompletionTriggerKind(completionContext.triggerKind),
                    ...(completionContext.triggerCharacter
                      ? { triggerCharacter: completionContext.triggerCharacter }
                      : {}),
                  },
                }
              : {}),
          };

          console.info('[LSP] Completion request', {
            uri: modelUri,
            line: position.lineNumber,
            column: position.column,
            triggerKind: completionContext?.triggerKind,
            triggerCharacter: completionContext?.triggerCharacter,
            lspTriggerKind: completionContext
              ? toLspCompletionTriggerKind(completionContext.triggerKind)
              : undefined,
          });

          const result = await client.request<LspCompletionList | LspCompletionItem[] | null>(
            'textDocument/completion',
            params,
          );

          if (!result) {
            console.warn('[LSP] Completion response: null/empty result', {
              uri: model.uri.toString(),
              line: position.lineNumber,
              column: position.column,
            });
            return { suggestions: [] };
          }

          const items: LspCompletionItem[] = Array.isArray(result) ? result : result.items;

          // Monaco requires a range on every suggestion — it decides what the
          // item replaces. Servers routinely omit textEdit, so fall back to the
          // word being typed, which is what VS Code's LSP client does too.
          const word = model.getWordUntilPosition(position);
          const wordRange = {
            startLineNumber: position.lineNumber,
            startColumn: word.startColumn,
            endLineNumber: position.lineNumber,
            endColumn: word.endColumn,
          };

          const suggestions = items.map((item) => {
            const label =
              typeof item.label === 'string' ? item.label : item.label.label;

            let documentation: { value: string } | undefined;
            if (item.documentation) {
              documentation =
                typeof item.documentation === 'string'
                  ? { value: item.documentation }
                  : { value: item.documentation.value };
            }

            const range = item.textEdit
              ? ('range' in item.textEdit
                  ? toMonacoRange(item.textEdit.range)
                  : {
                      insert: toMonacoRange(item.textEdit.insert),
                      replace: toMonacoRange(item.textEdit.replace),
                    })
              : undefined;

            return {
              label,
              kind: mapCompletionItemKind(item.kind, monaco.languages),
              insertText: item.textEdit?.newText ?? item.insertText ?? label,
              insertTextRules: item.insertTextFormat === 2
                ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet
                : undefined,
              detail: item.detail,
              documentation,
              sortText: item.sortText,
              filterText: item.filterText,
              range: range ?? wordRange,
            };
          });

          console.info('[LSP] Completion response mapped', {
            uri: model.uri.toString(),
            line: position.lineNumber,
            column: position.column,
            suggestionCount: suggestions.length,
          });

          markLspReadyFromActivity();
          return { suggestions };
        } catch (err) {
          console.error('[LSP] Completion error:', {
            error: err,
            uri: model.uri.toString(),
            line: position.lineNumber,
            column: position.column,
            triggerKind: completionContext?.triggerKind,
            triggerCharacter: completionContext?.triggerCharacter,
          });
          return { suggestions: [] };
        }
      },
    },
  );

  // ── a2) Unity Lifecycle Snippet CompletionItemProvider — C# only ─
  registerForLanguages(
    UNITY_ONLY_LANGUAGES,
    (lang, p) => monaco.languages.registerCompletionItemProvider(lang, p),
    {
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        const suggestions = UNITY_LIFECYCLE_METHODS.map((method) => ({
          label: method.name,
          kind: monaco.languages.CompletionItemKind.Snippet,
          insertText: method.snippetBody,
          insertTextRules: monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet,
          detail: 'Unity Lifecycle',
          documentation: method.detail,
          sortText: '0' + method.name,
          range,
        }));

        return { suggestions };
      },
    },
  );

  // ── a3) Fallback completions: Unity API names + C# keywords — C# only ─
  // These are plain identifier suggestions so users see SOMETHING while
  // Roslyn is indexing or if csharp-ls fails. They're suppressed after
  // a `.` so member-access completions stay LSP-driven.

  function isAfterDot(model: editor.ITextModel, position: Position): boolean {
    const lineUntil = model.getValueInRange({
      startLineNumber: position.lineNumber,
      startColumn: 1,
      endLineNumber: position.lineNumber,
      endColumn: position.column,
    });
    return /\.\s*$/.test(lineUntil);
  }

  registerForLanguages(
    UNITY_ONLY_LANGUAGES,
    (lang, p) => monaco.languages.registerCompletionItemProvider(lang, p),
    {
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        if (isAfterDot(model, position)) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        const kindMap = {
          type: monaco.languages.CompletionItemKind.Class,
          method: monaco.languages.CompletionItemKind.Method,
          property: monaco.languages.CompletionItemKind.Property,
        } as const;

        const suggestions = UNITY_API_NAMES.map((api) => ({
          label: api.name,
          kind: kindMap[api.kind],
          insertText: api.name,
          detail: api.detail,
          sortText: '8_' + api.name,
          range,
        }));

        return { suggestions };
      },
    },
  );

  registerForLanguages(
    UNITY_ONLY_LANGUAGES,
    (lang, p) => monaco.languages.registerCompletionItemProvider(lang, p),
    {
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        if (isAfterDot(model, position)) return { suggestions: [] };

        const word = model.getWordUntilPosition(position);
        const range = {
          startLineNumber: position.lineNumber,
          startColumn: word.startColumn,
          endLineNumber: position.lineNumber,
          endColumn: word.endColumn,
        };

        const suggestions = CSHARP_KEYWORDS.map((kw) => ({
          label: kw,
          kind: monaco.languages.CompletionItemKind.Keyword,
          insertText: kw,
          sortText: '9_' + kw,
          range,
        }));

        return { suggestions };
      },
    },
  );

  // ── b) HoverProvider ──────────────────────────────────────────
  registerForLanguages(
    TARGET_LANGUAGES,
    (lang, p) => monaco.languages.registerHoverProvider(lang, p),
    {
      async provideHover(model: editor.ITextModel, position: Position) {
        const ctx = getLspContextForModel(model);
        if (!ctx) return null;

        try {
          const params = buildTextDocumentPositionParams(model, position);
          const result = await ctx.client.request<LspHover | null>(
            'textDocument/hover',
            params,
          );

          if (!result) return null;

          // Normalise contents into an array of IMarkdownString
          let contents: Array<{ value: string }>;

          if (typeof result.contents === 'string') {
            contents = [{ value: result.contents }];
          } else if (Array.isArray(result.contents)) {
            contents = result.contents.map((c) =>
              typeof c === 'string' ? { value: c } : { value: c.value },
            );
          } else {
            contents = [{ value: result.contents.value }];
          }

          return {
            contents,
            range: result.range ? toMonacoRange(result.range) : undefined,
          };
        } catch (err) {
          console.error('[LSP] Hover error:', err);
          return null;
        }
      },
    },
  );

  // ── c) DefinitionProvider ─────────────────────────────────────
  registerForLanguages(
    TARGET_LANGUAGES,
    (lang, p) => monaco.languages.registerDefinitionProvider(lang, p),
    {
      async provideDefinition(model: editor.ITextModel, position: Position) {
        const ctx = getLspContextForModel(model);
        if (!ctx) return null;

        try {
          const params = buildTextDocumentPositionParams(model, position);
          const result = await ctx.client.request<
            LspLocation | LspLocation[] | LspLocationLink[] | null
          >('textDocument/definition', params);

          if (!result || (Array.isArray(result) && result.length === 0)) return null;

          const arr = Array.isArray(result) ? result : [result];

          // Monaco accepts both Location[] and DefinitionLink[]. LocationLink
          // lets us pass the origin selection range (highlights the token
          // under the cursor) and the target selection range (lands the
          // cursor on the symbol's name, not the start of its declaration
          // body — important for classes whose targetRange spans hundreds
          // of lines).
          return arr.map((loc) => {
            if (isLocationLink(loc)) {
              return {
                uri: monaco.Uri.parse(loc.targetUri),
                range: toMonacoRange(loc.targetSelectionRange ?? loc.targetRange),
                originSelectionRange: loc.originSelectionRange
                  ? toMonacoRange(loc.originSelectionRange)
                  : undefined,
              };
            }
            return {
              uri: monaco.Uri.parse(loc.uri),
              range: toMonacoRange(loc.range),
            };
          });
        } catch (err) {
          console.error('[LSP] Definition error:', err);
          return null;
        }
      },
    },
  );

  // ── d) SignatureHelpProvider ───────────────────────────────────
  registerForLanguages(
    TARGET_LANGUAGES,
    (lang, p) => monaco.languages.registerSignatureHelpProvider(lang, p),
    {
      signatureHelpTriggerCharacters: ['(', ','],

      async provideSignatureHelp(model: editor.ITextModel, position: Position) {
        const ctx = getLspContextForModel(model);
        if (!ctx) return null;

        try {
          const params = buildTextDocumentPositionParams(model, position);
          const result = await ctx.client.request<LspSignatureHelp | null>(
            'textDocument/signatureHelp',
            params,
          );

          if (!result) return null;

          const signatures = result.signatures.map((sig) => {
            let documentation: string | { value: string } | undefined;
            if (sig.documentation) {
              documentation =
                typeof sig.documentation === 'string'
                  ? sig.documentation
                  : { value: sig.documentation.value };
            }

            const parameters = (sig.parameters ?? []).map((param) => {
              let paramDoc: string | { value: string } | undefined;
              if (param.documentation) {
                paramDoc =
                  typeof param.documentation === 'string'
                    ? param.documentation
                    : { value: param.documentation.value };
              }
              return {
                label: param.label,
                documentation: paramDoc,
              };
            });

            return {
              label: sig.label,
              documentation,
              parameters,
              activeParameter: sig.activeParameter,
            };
          });

          return {
            value: {
              signatures,
              activeSignature: result.activeSignature ?? 0,
              activeParameter: result.activeParameter ?? 0,
            },
            dispose() {},
          };
        } catch (err) {
          console.error('[LSP] SignatureHelp error:', err);
          return null;
        }
      },
    },
  );

  // ── e) Diagnostics ────────────────────────────────────────────
  // Push (`textDocument/publishDiagnostics`) is wired per-client in
  // `attachClientToProviders` since it requires a notification listener
  // on a specific LspClient instance.
  //
  // Pull (`textDocument/diagnostic`) is csharp-only — csharp-ls 0.22+
  // uses the LSP 3.17 PULL model and never publishes. Pyright and
  // typescript-language-server both push, so they're fully covered by
  // the per-client push listener below.

  // ── Unity "unused symbol" suppression ─────────────────────────
  // The Unity analyzers feature USES SerializeField/public fields and Unity
  // message methods that csharp-ls/Roslyn flag as "never used" (because nothing
  // in C# references them — Unity does, via serialization/reflection). When the
  // active project is Unity (and analyzers are on) we filter those specific
  // unused diagnostics out so the user isn't told their serialized fields and
  // lifecycle methods are dead code. Targeted on purpose: only the unused-symbol
  // diagnostic codes/messages below are considered, and only when the symbol at
  // the marker range is a Unity message name or a serialized field.
  const UNITY_MESSAGE_NAMES = new Set(UNITY_LIFECYCLE_METHODS.map((m) => m.name));
  // CS0169 field never used; CS0414 assigned but never used; CS0649 never
  // assigned; IDE0051 unused private member; IDE0044 make readonly (noise on
  // serialized fields). Plus a message fallback for servers that omit codes.
  const UNUSED_CODES = new Set(['CS0169', '0169', 'CS0414', '0414', 'CS0649', '0649', 'IDE0051', 'IDE0044']);
  const UNUSED_MESSAGE_RE = /\bis never used\b|\bnever assigned to\b|\bassigned but its value is never used\b|\bunused (private )?(field|member)\b/i;

  function unityAnalyzersActive(): boolean {
    return (
      useProjectContextStore.getState().isUnityProject &&
      useSettingsStore.getState().getSetting('unity.analyzers.enabled') === true
    );
  }

  function diagCodeString(diag: LspDiagnostic): string {
    return diag.code != null ? String(diag.code) : '';
  }

  function isUnusedDiagnostic(diag: LspDiagnostic): boolean {
    const code = diagCodeString(diag);
    if (code && UNUSED_CODES.has(code)) return true;
    return UNUSED_MESSAGE_RE.test(diag.message);
  }

  /**
   * Cheap check: is the symbol at this diagnostic's range one the Unity
   * analyzers rely on (a Unity message method, or a [SerializeField]/public
   * field in a MonoBehaviour/ScriptableObject)? Reads only a small window of
   * model text around the marker — no full parse.
   */
  function isUnityUsedSymbol(model: editor.ITextModel, diag: LspDiagnostic): boolean {
    const line = diag.range.start.line + 1; // 1-based
    // Identifier highlighted by the diagnostic (Roslyn ranges the symbol name).
    const word = model.getWordAtPosition({
      lineNumber: line,
      column: diag.range.start.character + 1,
    });
    const symbol = word?.word ?? '';

    // (a) Unity message method name.
    if (symbol && UNITY_MESSAGE_NAMES.has(symbol)) return true;

    // (b) Serialized field: the declaration line has [SerializeField] or is
    //     public, AND an enclosing class extends MonoBehaviour/ScriptableObject.
    const lineText = model.getLineContent(line);
    const declLooksSerialized =
      /\[\s*SerializeField\b/.test(lineText) ||
      /\bpublic\b/.test(lineText) ||
      // attribute may sit on the previous line
      (line > 1 && /\[\s*SerializeField\b/.test(model.getLineContent(line - 1)));
    if (!declLooksSerialized) return false;

    // Scan upward (bounded) for the enclosing class's base list.
    const start = Math.max(1, line - 400);
    for (let l = line; l >= start; l--) {
      const t = model.getLineContent(l);
      const cls = /\bclass\s+\w+[^{]*:\s*([^{]+)/.exec(t);
      if (cls && /\b(MonoBehaviour|ScriptableObject)\b/.test(cls[1])) return true;
      // Stop if we hit a class with a non-Unity base (different scope).
      if (/\bclass\s+\w+/.test(t)) return false;
    }
    return false;
  }

  function applyDiagnostics(uri: string, diagnostics: LspDiagnostic[]): void {
    const model = monaco.editor.getModel(monaco.Uri.parse(uri));
    if (!model) return;

    // Filter Unity-used "unused symbol" diagnostics (no-op outside Unity).
    if (model.getLanguageId() === 'csharp' && unityAnalyzersActive()) {
      diagnostics = diagnostics.filter(
        (d) => !(isUnusedDiagnostic(d) && isUnityUsedSymbol(model, d)),
      );
    }

    const markers = diagnostics.map((diag) => {
      let severity: number;
      switch (diag.severity) {
        case 1: severity = monaco.MarkerSeverity.Error; break;
        case 2: severity = monaco.MarkerSeverity.Warning; break;
        case 3: severity = monaco.MarkerSeverity.Info; break;
        case 4: severity = monaco.MarkerSeverity.Hint; break;
        default: severity = monaco.MarkerSeverity.Info;
      }

      return {
        severity,
        startLineNumber: diag.range.start.line + 1,
        startColumn: diag.range.start.character + 1,
        endLineNumber: diag.range.end.line + 1,
        endColumn: diag.range.end.character + 1,
        message: diag.message,
        source: diag.source,
        code: diag.code != null ? String(diag.code) : undefined,
      };
    });

    monaco.editor.setModelMarkers(model, 'lsp', markers);
    markLspReadyFromActivity();

    const filePath = pathFromFileUri(uri);
    const fileName = filePath.split('/').pop() || '';
    const severityMap: Record<number, 'error' | 'warning' | 'info' | 'hint'> = {
      1: 'error',
      2: 'warning',
      3: 'info',
      4: 'hint',
    };
    const diagItems = diagnostics.map((diag) => ({
      file: filePath,
      fileName,
      line: diag.range.start.line + 1,
      col: diag.range.start.character + 1,
      message: diag.message,
      severity: severityMap[diag.severity ?? 3] ?? 'info',
      source: 'lsp',
    }));
    useUiStore.getState().setFileDiagnostics(uri, 'lsp', diagItems);
  }

  // Pull path — csharp-ls 0.22+ requires us to ask. Only csharp models
  // are watched; other languages use push.
  const pullTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const lastResultIds = new Map<string, string>();

  async function pullDiagnostics(uri: string): Promise<void> {
    const csharpClient = lspManager.client('csharp');
    if (!csharpClient.isRunning()) return;

    // Hold everything until csharp-ls has a project graph. Answers from before
    // that point are a CS0518 cascade over the whole file, not a real report —
    // see `project-readiness.ts`. Dropping the pull is safe rather than lossy:
    // the gate-opened handler below re-pulls every open C# model.
    if (!isCsharpProjectLoaded()) return;

    try {
      const previousResultId = lastResultIds.get(uri);
      const params: { textDocument: { uri: string }; previousResultId?: string } = {
        textDocument: { uri },
      };
      if (previousResultId) params.previousResultId = previousResultId;

      const result = await csharpClient.request<{
        kind: 'full' | 'unchanged';
        resultId?: string;
        items?: LspDiagnostic[];
      } | null>('textDocument/diagnostic', params);

      if (!result) return;
      if (result.resultId) lastResultIds.set(uri, result.resultId);
      if (result.kind === 'unchanged') return;
      applyDiagnostics(uri, result.items ?? []);
    } catch (err) {
      // csharp-ls returns ContentModified (-32801) when the file changes
      // mid-flight. That's expected — the next debounced pull will handle
      // the new content. Other errors are worth logging.
      const msg = err instanceof Error ? err.message : String(err);
      if (!msg.includes('-32801') && !msg.includes('ContentModified')) {
        console.warn('[LSP] pullDiagnostics failed:', err);
      }
    }
  }

  function schedulePull(uri: string, delayMs: number): void {
    const existing = pullTimers.get(uri);
    if (existing) clearTimeout(existing);
    const t = setTimeout(() => {
      pullTimers.delete(uri);
      pullDiagnostics(uri);
    }, delayMs);
    pullTimers.set(uri, t);
  }

  /** Drop everything keyed by `uri`. Safe to call for an unwatched uri. */
  function forgetPullState(uri: string): void {
    const t = pullTimers.get(uri);
    if (t) {
      clearTimeout(t);
      pullTimers.delete(uri);
    }
    lastResultIds.delete(uri);
  }

  function watchModel(model: editor.ITextModel): void {
    if (model.getLanguageId() !== 'csharp') return;
    const uri = model.uri.toString();

    // Initial pull (small delay to let didOpen reach the server first). Gated
    // on project readiness inside `pullDiagnostics`; if the project is still
    // loading this is dropped and the gate-opened handler re-pulls instead.
    schedulePull(uri, 300);

    const sub = model.onDidChangeContent(() => {
      schedulePull(uri, 500);
    });
    disposables.push(sub);

    // Closing a tab disposes the model (`disposeModelForPath`) but Monaco keys
    // markers by resource URI, not by model instance — so without this the
    // squiggles outlive the model and reattach the moment the file is reopened.
    // Paired with dropping `lastResultIds`, since a retained resultId makes the
    // next pull answer `kind: "unchanged"` and never repaint those stale
    // markers. Together these are what made a bad report survive a close and
    // reopen, leaving an app restart as the only way out.
    const disposeSub = model.onWillDispose(() => {
      forgetPullState(uri);
      monaco.editor.setModelMarkers(model, 'lsp', []);
    });
    disposables.push(disposeSub);

    const langSub = model.onDidChangeLanguage((e) => {
      if (e.newLanguage !== 'csharp') {
        const t = pullTimers.get(uri);
        if (t) {
          clearTimeout(t);
          pullTimers.delete(uri);
        }
      }
    });
    disposables.push(langSub);
  }

  for (const m of monaco.editor.getModels()) watchModel(m);
  const createSub = monaco.editor.onDidCreateModel((m: editor.ITextModel) => watchModel(m));
  disposables.push(createSub);

  // The project graph just became usable (or csharp-ls restarted and rebuilt
  // it). Every C# model on screen is now showing either nothing — its initial
  // pull was dropped by the gate — or a report computed against the previous
  // graph. Re-pull all of them.
  //
  // `lastResultIds` is cleared first, and deliberately so: the cached ids were
  // issued by the old graph, and sending one back invites `kind: "unchanged"`,
  // which is exactly how a wrong report used to become permanent. Forcing a
  // full report costs one round trip per open file, once per server lifetime.
  const readyUnsub = onCsharpProjectLoaded(() => {
    lastResultIds.clear();
    for (const m of monaco.editor.getModels()) {
      if (m.getLanguageId() === 'csharp') schedulePull(m.uri.toString(), 300);
    }
  });
  disposables.push({ dispose: readyUnsub });

  // Stash the diagnostic-application handle on the disposer closure so
  // `attachClientToProviders` (a sibling export, called per-client by the
  // workspace store) can route push events into the same logic.
  pushDiagnosticsApplier = applyDiagnostics;

  // ── f) ReferenceProvider ──────────────────────────────────────
  registerForLanguages(
    TARGET_LANGUAGES,
    (lang, p) => monaco.languages.registerReferenceProvider(lang, p),
    {
      async provideReferences(
        model: editor.ITextModel,
        position: Position,
        context: { includeDeclaration: boolean },
      ) {
        const ctx = getLspContextForModel(model);
        if (!ctx) return null;

        try {
          const params = {
            ...buildTextDocumentPositionParams(model, position),
            context: { includeDeclaration: context.includeDeclaration },
          };
          const result = await ctx.client.request<LspLocation[] | null>(
            'textDocument/references',
            params,
          );

          if (!result) return null;

          return result.map((loc) => ({
            uri: monaco.Uri.parse(loc.uri),
            range: toMonacoRange(loc.range),
          }));
        } catch (err) {
          console.error('[LSP] References error:', err);
          return null;
        }
      },
    },
  );

  // ── g) RenameProvider (rename + post-processor registry) ──────
  disposables.push({ dispose: registerLspRenameProviders(monaco) });

  // ── h) CodeActionProvider (LSP + local quick-fix sources) ─────
  disposables.push({ dispose: registerLspCodeActionProviders(monaco) });

  // ── h2) workspace/applyEdit (server→client) handler ───────────
  // Routes server-initiated applyEdit requests through the same
  // applier used by rename and code actions (injected into client.ts
  // to avoid an import cycle — see registerApplyEditHandler).
  disposables.push({ dispose: registerApplyEditHandler() });

  // ── i) Editor Opener (cross-file Go to Definition) ────────────
  const openerDisposable = monaco.editor.registerEditorOpener({
    async openCodeEditor(
      source: editor.ICodeEditor,
      resource: InstanceType<typeof monaco.Uri>,
      selectionOrPosition?:
        | { lineNumber: number; column: number }
        | { startLineNumber: number; startColumn: number; endLineNumber: number; endColumn: number },
    ): Promise<boolean> {
      const uri = resource.toString();
      if (!uri.startsWith('file://')) return false;

      const filePath = pathFromFileUri(uri);
      const fileName = filePath.split('/').pop() || filePath;

      // Same file — let Monaco handle internally
      const currentModel = source.getModel();
      if (currentModel && currentModel.uri.toString() === uri) {
        return false;
      }

      // Store target position for the new editor to consume on mount
      if (selectionOrPosition) {
        if ('lineNumber' in selectionOrPosition) {
          setPendingNavigation({
            line: selectionOrPosition.lineNumber,
            column: selectionOrPosition.column,
          });
        } else {
          setPendingNavigation({
            line: selectionOrPosition.startLineNumber,
            column: selectionOrPosition.startColumn,
          });
        }
      }

      // Open the file via workspace store (triggers editor re-mount)
      const { openFile } = useWorkspaceStore.getState();
      await openFile(filePath, fileName);
      return true;
    },
  });
  disposables.push(openerDisposable);

  // ── Dispose all ───────────────────────────────────────────────
  return () => {
    console.info('[LSP] Disposing Monaco LSP providers', { count: disposables.length });
    for (const d of disposables) d.dispose();
    for (const t of pullTimers.values()) clearTimeout(t);
    pullTimers.clear();
    lastResultIds.clear();
    pushDiagnosticsApplier = null;
  };
}

// ── Per-client push diagnostics ─────────────────────────────────
//
// The Monaco-side providers above are language-static and registered
// once. The push-diagnostics notification is per-client, so the
// workspace store calls `attachClientToProviders(client)` after each
// successful `client.start()` to route that server's diagnostics into
// the shared `applyDiagnostics` closure. Returns an unsubscribe.

let pushDiagnosticsApplier:
  | ((uri: string, diagnostics: LspDiagnostic[]) => void)
  | null = null;

export function attachClientToProviders(client: LspClient): () => void {
  return client.onNotification(
    'textDocument/publishDiagnostics',
    (params: unknown) => {
      if (!pushDiagnosticsApplier) return;
      const { uri, diagnostics } = params as LspPublishDiagnosticsParams;
      pushDiagnosticsApplier(uri, filterDiagnosticsForLanguage(client.languageId, diagnostics));
    },
  );
}

/**
 * `typescript-language-server` emits "suggestion diagnostics" (severity 4 /
 * Hint) for unused-variable / unused-import codes (TS6133, TS6192, TS6196,
 * TS6198, TS6205, TS7028) **regardless** of the user's `noUnusedLocals` /
 * `noUnusedParameters` tsconfig settings — those flags only control
 * compile-time errors, not the IDE's hint stream. Users who explicitly
 * opt out via `noUnusedLocals: false` reasonably expect these not to show.
 *
 * Filter the unused-* suggestions for typescript clients. Real errors
 * (severity 1) and other hints unrelated to `noUnusedLocals` still flow.
 */
const TS_UNUSED_HINT_CODES = new Set<string>([
  '6133', '6192', '6196', '6198', '6205', '7028',
]);

function filterDiagnosticsForLanguage(
  languageId: string,
  diagnostics: LspDiagnostic[],
): LspDiagnostic[] {
  if (languageId !== 'typescript') return diagnostics;
  return diagnostics.filter((d) => {
    if (d.severity !== 4) return true;
    const code = d.code != null ? String(d.code) : '';
    return !TS_UNUSED_HINT_CODES.has(code);
  });
}
