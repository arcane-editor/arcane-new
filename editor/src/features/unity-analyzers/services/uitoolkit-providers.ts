// IntelliSense for the stringly-typed boundary between C# and UI Toolkit.
//
// A Unity developer writing UI code is not sitting in the `.uxml` — structure
// comes from the UI Builder for most projects. They are in the controller, and
// the join to their UI is a bare string with nothing behind it:
//
//     root.Q<Button>("play-butt|      no completion, no hover, no F12
//
// Unity cannot fix that: the UI Builder has no view of your C#, and `csharp-ls`
// has no view of your UXML. This editor is the only place both halves exist.
//
// Registered ALONGSIDE csharp-ls rather than replacing it. Monaco merges
// completion results from every provider, stacks hovers, and takes the first
// non-empty definition — and this repo already does exactly this on `csharp`
// (`so-codelens.ts` a code lens, `analyzer-engine.ts` a code-action source) and
// on `json` (`manifest-providers.ts` completion plus hover).

import type { Monaco } from '@monaco-editor/react';
import type { editor, languages, Position, IDisposable } from 'monaco-editor';
import { queryContextAt } from '../../../utils/uitoolkit-query-context';
import { typeChainFor } from '../../../utils/uxml-controls';
import { useSettingsStore } from '../../../stores/settings';
import { useProjectContextStore } from '../../../stores/project-context';
import { getUxmlIndex, getUssIndex, type ElementDecl } from './uitoolkit-cache';

function enabled(): boolean {
  return (
    useProjectContextStore.getState().isUnityProject &&
    useSettingsStore.getState().getSetting('unity.uiDiagnostics.enabled') !== false
  );
}

/** `Assets/UI/MainMenu.uxml` -> `MainMenu.uxml`. */
function fileName(path: string): string {
  return path.split('/').pop() ?? path;
}

/** The context at a position, or null when this is not a UI Toolkit query. */
function contextAt(model: editor.ITextModel, position: Position) {
  if (!enabled()) return null;
  return queryContextAt(model.getValue(), model.getOffsetAt(position));
}

// ── Completion ───────────────────────────────────────────────────────────────

function elementCompletions(
  monaco: Monaco,
  wanted: string | null,
  range: languages.CompletionItem['range'],
): languages.CompletionItem[] {
  const uxml = getUxmlIndex();
  if (!uxml) return [];

  const out: languages.CompletionItem[] = [];
  for (const [name, decls] of uxml.elements) {
    const decl = decls[0];
    // Rank by whether the element actually IS what the generic asked for. That
    // is the difference between a list and IntelliSense.
    const assignable = wanted ? decls.some((d) => typeChainFor(d.tag).includes(wanted)) : true;
    const docs = [...new Set(decls.map((d) => fileName(d.path)))].join(', ');
    out.push({
      label: name,
      kind: monaco.languages.CompletionItemKind.Value,
      insertText: name,
      range,
      detail: `${decl.tag}  ·  ${docs}`,
      // A leading space sorts before everything Monaco gets from csharp-ls, so
      // the names that fit the requested type come first.
      sortText: `${assignable ? ' ' : '~'}${name}`,
      documentation: decls.length > 1
        ? { value: `Declared in ${decls.length} documents: ${docs}` }
        : undefined,
    });
  }
  return out;
}

function classCompletions(
  monaco: Monaco,
  range: languages.CompletionItem['range'],
): languages.CompletionItem[] {
  const uss = getUssIndex();
  const uxml = getUxmlIndex();
  if (!uss && !uxml) return [];

  // Both halves: a class a stylesheet declares, and one only the UXML uses.
  const names = new Set<string>([
    ...(uss ? uss.allClasses : []),
    ...(uxml ? uxml.classesToDocs.keys() : []),
  ]);

  return [...names].map((cls) => {
    const sheets = uss?.declaredClasses.get(cls) ?? [];
    return {
      label: cls,
      kind: monaco.languages.CompletionItemKind.Color,
      insertText: cls,
      range,
      detail: sheets.length > 0
        ? sheets.map(fileName).join(', ')
        : 'used in UXML, declared by no stylesheet',
      sortText: ` ${cls}`,
    };
  });
}

function completionProvider(monaco: Monaco): languages.CompletionItemProvider {
  return {
    // Re-run as the name is typed. `"` opens the literal; `-` is in almost
    // every UXML name (`play-button`) and would otherwise end the word.
    triggerCharacters: ['"', '-'],
    provideCompletionItems(model, position) {
      const ctx = contextAt(model, position);
      if (!ctx) return { suggestions: [] };

      // Replace the whole literal, not the word under the caret: `play-button`
      // is one name and Monaco's word boundary would split it at the hyphen.
      const from = model.getPositionAt(ctx.start);
      const range = {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: position.lineNumber,
        endColumn: position.column,
      };

      return {
        suggestions:
          ctx.slot === 'className'
            ? classCompletions(monaco, range)
            : elementCompletions(monaco, ctx.typeArg, range),
      };
    },
  };
}

// ── Hover ────────────────────────────────────────────────────────────────────

function describe(name: string, decls: ElementDecl[], wanted: string | null): string {
  const lines: string[] = [];
  const first = decls[0];
  lines.push(`**${name}** · \`${first.tag}\``);
  if (first.classes.length > 0) lines.push(`classes: \`${first.classes.join(' ')}\``);
  lines.push('');
  for (const d of decls) lines.push(`- ${d.path}:${d.line}`);

  if (wanted && !decls.some((d) => typeChainFor(d.tag).includes(wanted))) {
    lines.push('');
    lines.push(
      `⚠ Queried as \`${wanted}\`, but this is a \`${first.tag}\` — ` +
      `\`Q<${wanted}>()\` filters by type and returns null.`,
    );
  }
  return lines.join('\n');
}

function hoverProvider(): languages.HoverProvider {
  return {
    provideHover(model, position) {
      const ctx = contextAt(model, position);
      if (!ctx || ctx.value === '') return null;

      const from = model.getPositionAt(ctx.start);
      const to = model.getPositionAt(ctx.end);
      const range = {
        startLineNumber: from.lineNumber,
        startColumn: from.column,
        endLineNumber: to.lineNumber,
        endColumn: to.column,
      };

      if (ctx.slot === 'className') {
        const uss = getUssIndex();
        const sheets = uss?.declaredClasses.get(ctx.value) ?? [];
        return {
          range,
          contents: [{
            value: sheets.length > 0
              ? `**.${ctx.value}**\n\n${sheets.map((s) => `- ${s}`).join('\n')}`
              : `**.${ctx.value}**\n\nNo stylesheet declares this class.`,
          }],
        };
      }

      const decls = getUxmlIndex()?.elements.get(ctx.value);
      if (!decls || decls.length === 0) return null;
      return { range, contents: [{ value: describe(ctx.value, decls, ctx.typeArg) }] };
    },
  };
}

// ── Go to definition ─────────────────────────────────────────────────────────

/**
 * F12 on a string literal.
 *
 * csharp-ls has no definition for a string, so it returns nothing and Monaco
 * falls through to this — no conflict to arbitrate.
 */
function definitionProvider(monaco: Monaco, workspaceRoot: () => string | null): languages.DefinitionProvider {
  return {
    provideDefinition(model, position) {
      const ctx = contextAt(model, position);
      if (!ctx || ctx.slot !== 'name' || ctx.value === '') return null;

      const decls = getUxmlIndex()?.elements.get(ctx.value);
      if (!decls || decls.length === 0) return null;

      const root = workspaceRoot();
      return decls.map((d) => ({
        uri: monaco.Uri.file(root ? `${root}/${d.path}` : d.path),
        range: {
          startLineNumber: d.line,
          startColumn: d.column,
          endLineNumber: d.line,
          endColumn: d.column + d.name.length,
        },
      }));
    },
  };
}

// ── Registration ─────────────────────────────────────────────────────────────

let disposers: IDisposable[] = [];

/** Idempotent. Returns a disposer. */
export function registerUiToolkitCsProviders(
  monaco: Monaco,
  workspaceRoot: () => string | null,
): () => void {
  if (disposers.length > 0) return disposeUiToolkitCsProviders;
  disposers = [
    monaco.languages.registerCompletionItemProvider('csharp', completionProvider(monaco)),
    monaco.languages.registerHoverProvider('csharp', hoverProvider()),
    monaco.languages.registerDefinitionProvider('csharp', definitionProvider(monaco, workspaceRoot)),
  ];
  return disposeUiToolkitCsProviders;
}

export function disposeUiToolkitCsProviders(): void {
  for (const d of disposers.splice(0)) d.dispose();
}
