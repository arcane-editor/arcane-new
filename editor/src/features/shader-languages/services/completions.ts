import type { Monaco } from '@monaco-editor/react';
import type { editor, Position, languages } from 'monaco-editor';
import { useSettingsStore } from '../../../stores/settings';
import type { ShaderCompletion } from '../data/shaderlab';
import {
  SHADERLAB_STRUCTURE,
  SHADERLAB_PRAGMAS,
  SHADERLAB_TAG_KEYS,
  SHADERLAB_TAG_VALUES,
} from '../data/shaderlab';
import {
  HLSL_INTRINSICS,
  HLSL_TYPES,
  HLSL_KEYWORDS,
  HLSL_UNITY_MACROS,
  HLSL_COMMON_INCLUDES,
} from '../data/hlsl';

/**
 * Whether shader completions are enabled. Gated on the `unity.shader.completions`
 * setting (default true). Read lazily per-request so toggling the setting takes
 * effect without re-registering providers.
 *
 * Not gated on `isUnityProject`: `.shader`/`.hlsl`/`.cginc` files are inherently
 * Unity-flavoured, and a user editing one in a non-Unity-rooted workspace still
 * wants the help. (Include *navigation* to the editor's built-in CGIncludes is
 * separately best-effort and degrades gracefully — see include-resolver.ts.)
 */
function completionsEnabled(): boolean {
  return useSettingsStore.getState().getSetting('unity.shader.completions') !== false;
}

/** Text on the current line up to (but not including) the cursor column. */
function lineUpToCursor(model: editor.ITextModel, position: Position): string {
  return model.getValueInRange({
    startLineNumber: position.lineNumber,
    startColumn: 1,
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  });
}

/** The word range at the cursor — used as the completion replacement range. */
function wordRange(model: editor.ITextModel, position: Position) {
  const word = model.getWordUntilPosition(position);
  return {
    startLineNumber: position.lineNumber,
    startColumn: word.startColumn,
    endLineNumber: position.lineNumber,
    endColumn: word.endColumn,
  };
}

/**
 * Map our plain `ShaderCompletion` records into Monaco completion items.
 * `sortPrefix` biases ordering within the list (lower sorts earlier).
 */
function toSuggestions(
  monaco: Monaco,
  items: ShaderCompletion[],
  range: languages.CompletionItem['range'],
  kind: languages.CompletionItemKind,
  sortPrefix: string,
): languages.CompletionItem[] {
  const snippetRule = monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet;
  return items.map((item) => ({
    label: item.label,
    kind,
    insertText: item.insertText ?? item.label,
    insertTextRules: item.snippet ? snippetRule : undefined,
    detail: item.detail,
    documentation: item.documentation ? { value: item.documentation } : undefined,
    sortText: sortPrefix + item.label,
    range,
  }));
}

/**
 * Build the completion range for an `#include "..."` path. We replace the whole
 * partial path inside the quotes (which `getWordUntilPosition` would split on
 * `/`, `.`, etc.), so completions like full package paths insert cleanly.
 */
function includePathRange(position: Position, quoteColumn: number) {
  return {
    startLineNumber: position.lineNumber,
    startColumn: quoteColumn + 1, // just after the opening quote
    endLineNumber: position.lineNumber,
    endColumn: position.column,
  };
}

const INCLUDE_RE = /#\s*include\s*"([^"]*)$/;
const PRAGMA_RE = /#\s*pragma\s+\S*$/;

/**
 * Register completion providers for the ShaderLab and HLSL Monaco languages.
 * Returns a dispose function tearing down all registrations.
 *
 * Providers are language-scoped to `shaderlabLangId` / `hlslLangId`, so they
 * never surface inside C#/TS/etc. Each provider early-returns when the
 * `unity.shader.completions` setting is off.
 */
export function registerShaderCompletions(
  monaco: Monaco,
  shaderlabLangId: string,
  hlslLangId: string,
): () => void {
  const disposables: Array<{ dispose(): void }> = [];
  const K = monaco.languages.CompletionItemKind;

  // Shared `#include "..."` path completion logic (both languages support it).
  function includeSuggestions(
    position: Position,
    line: string,
  ): languages.ProviderResult<languages.CompletionList> | null {
    const m = INCLUDE_RE.exec(line);
    if (!m) return null;
    const quoteColumn = line.lastIndexOf('"') + 1; // 1-based column of the quote
    const range = includePathRange(position, quoteColumn);
    return {
      suggestions: toSuggestions(monaco, HLSL_COMMON_INCLUDES, range, K.File, '0_'),
    };
  }

  // ── ShaderLab provider ────────────────────────────────────────
  disposables.push(
    monaco.languages.registerCompletionItemProvider(shaderlabLangId, {
      triggerCharacters: ['"', '#', '/'],
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        if (!completionsEnabled()) return { suggestions: [] };

        const line = lineUpToCursor(model, position);

        // #include "..." — offer common include targets.
        const inc = includeSuggestions(position, line);
        if (inc) return inc;

        // #pragma ... — offer pragma directives.
        if (PRAGMA_RE.test(line)) {
          const range = wordRange(model, position);
          return {
            suggestions: toSuggestions(monaco, SHADERLAB_PRAGMAS, range, K.Keyword, '0_'),
          };
        }

        const range = wordRange(model, position);

        // Inside a Tags { ... } block: offer tag keys (and bare values when the
        // cursor sits in the value half after `=`).
        if (/\bTags\b[^}]*$/.test(line) && !/}\s*$/.test(line)) {
          const afterEquals = /=\s*"?[^"]*$/.test(line);
          const suggestions = [
            ...toSuggestions(monaco, SHADERLAB_TAG_KEYS, range, K.Property, '0_'),
            ...(afterEquals
              ? toSuggestions(monaco, SHADERLAB_TAG_VALUES, range, K.Value, '1_')
              : []),
          ];
          return { suggestions };
        }

        // Default: structure keywords (Shader/SubShader/Pass/...).
        return {
          suggestions: toSuggestions(monaco, SHADERLAB_STRUCTURE, range, K.Keyword, '2_'),
        };
      },
    }),
  );

  // ── HLSL provider ─────────────────────────────────────────────
  disposables.push(
    monaco.languages.registerCompletionItemProvider(hlslLangId, {
      triggerCharacters: ['"', '#', '/'],
      provideCompletionItems(model: editor.ITextModel, position: Position) {
        if (!completionsEnabled()) return { suggestions: [] };

        const line = lineUpToCursor(model, position);

        // #include "..." — offer common include targets.
        const inc = includeSuggestions(position, line);
        if (inc) return inc;

        const range = wordRange(model, position);

        // Intrinsics + Unity macros + types + keywords. Macros sort first
        // (Unity devs reach for TEXTURE2D/SAMPLE_* constantly), then
        // intrinsics, then types, then control-flow keywords.
        const suggestions = [
          ...toSuggestions(monaco, HLSL_UNITY_MACROS, range, K.Function, '0_'),
          ...toSuggestions(monaco, HLSL_INTRINSICS, range, K.Function, '1_'),
          ...toSuggestions(monaco, HLSL_TYPES, range, K.Struct, '2_'),
          ...toSuggestions(monaco, HLSL_KEYWORDS, range, K.Keyword, '3_'),
        ];
        return { suggestions };
      },
    }),
  );

  return () => {
    for (const d of disposables) d.dispose();
  };
}
