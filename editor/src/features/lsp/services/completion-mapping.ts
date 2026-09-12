/**
 * LSP completion → Monaco suggestion mapping.
 *
 * Pure and Monaco-free by construction: the enum values Monaco needs are
 * passed in rather than imported, so every branch here is reachable from a
 * test. The registration shell stays in `providers.ts`.
 *
 * This lives apart from `providers.ts` because it is the part that is easy to
 * get quietly wrong. Every field below decides something visible — what the
 * item replaces, whether it expands as a snippet or lands as literal text,
 * where it sorts — and a mistake in any of them looks like "the server
 * returned bad completions" rather than like a client bug.
 */

import type { LspRange } from './model-context';
import type { ServerProfile } from './server-profiles';

// ── Wire shapes (structural, not imported from an LSP package) ──

export type LspTextEditLike =
  | { range: LspRange; newText: string }
  | { insert: LspRange; replace: LspRange; newText: string };

export interface LspCompletionItem {
  label: string | { label: string; detail?: string; description?: string };
  kind?: number;
  detail?: string;
  documentation?: string | { kind: string; value: string };
  sortText?: string;
  filterText?: string;
  insertText?: string;
  /** 1 = PlainText, 2 = Snippet. */
  insertTextFormat?: number;
  textEdit?: LspTextEditLike;
  /**
   * Edits elsewhere in the file that must be applied WITH the completion —
   * for a Roslyn server this is the `using` directive an unimported type
   * needs. Dropping them inserts the identifier and nothing else, which does
   * not compile.
   */
  additionalTextEdits?: Array<{ range: LspRange; newText: string }>;
  /** Opaque server payload, echoed back on `completionItem/resolve`. */
  data?: unknown;
  commitCharacters?: string[];
  preselect?: boolean;
  /** 1 = Deprecated. */
  tags?: number[];
  deprecated?: boolean;
}

/**
 * LSP 3.17 `CompletionList.itemDefaults`. The client advertises support for
 * these (see `client.ts`), and advertising it is a promise: a server may then
 * hoist the fields out of every item and send them once. Ignoring what we
 * asked for is how snippets arrive as literal placeholder text and edits land
 * in the wrong range — a silent failure on both sides.
 */
export interface LspItemDefaults {
  commitCharacters?: string[];
  editRange?: LspRange | { insert: LspRange; replace: LspRange };
  insertTextFormat?: number;
  insertTextMode?: number;
  data?: unknown;
}

export interface LspCompletionList {
  isIncomplete: boolean;
  items: LspCompletionItem[];
  itemDefaults?: LspItemDefaults;
}

// ── Monaco-side shapes ──────────────────────────────────────────

export interface MonacoRange {
  startLineNumber: number;
  startColumn: number;
  endLineNumber: number;
  endColumn: number;
}

export type MonacoInsertRange =
  | MonacoRange
  | { insert: MonacoRange; replace: MonacoRange };

export interface MonacoSuggestion {
  label: string | { label: string; detail?: string; description?: string };
  kind: number;
  insertText: string;
  insertTextRules?: number;
  detail?: string;
  documentation?: { value: string };
  sortText?: string;
  filterText?: string;
  commitCharacters?: string[];
  preselect?: boolean;
  tags?: number[];
  range: MonacoInsertRange;
  /** Monaco's `ISingleEditOperation` shape. */
  additionalTextEdits?: Array<{ range: MonacoRange; text: string }>;
  /**
   * The item exactly as the server sent it, kept so `resolveCompletionItem`
   * can hand it back — `data` is opaque, and a server given a rebuilt item
   * cannot look up whatever it cached against it.
   */
  _lsp?: LspCompletionItem;
  /**
   * Which language server produced this item.
   *
   * `resolveCompletionItem` receives only the item and a token — no model, no
   * language — and the provider is registered for every LSP-backed language.
   * Without this, resolving a TypeScript completion would send that server's
   * opaque `data` to csharp-ls.
   */
  _server?: string;
}

/**
 * The Monaco enum values this module needs, injected so the module itself
 * stays importable outside a browser.
 */
export interface MonacoCompletionEnums {
  /** `monaco.languages.CompletionItemKind`. */
  kinds: Record<string, number>;
  /** `monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet`. */
  insertAsSnippet: number;
  /** `monaco.languages.CompletionItemTag.Deprecated`. */
  deprecatedTag: number;
}

// ── Range conversion (0-based LSP → 1-based Monaco) ─────────────

function toMonacoRange(range: LspRange): MonacoRange {
  return {
    startLineNumber: range.start.line + 1,
    startColumn: range.start.character + 1,
    endLineNumber: range.end.line + 1,
    endColumn: range.end.character + 1,
  };
}

function editRangeToMonaco(
  edit: LspTextEditLike | LspRange | { insert: LspRange; replace: LspRange },
): MonacoInsertRange {
  if ('insert' in edit && 'replace' in edit) {
    return { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) };
  }
  if ('range' in edit) return toMonacoRange(edit.range);
  return toMonacoRange(edit as LspRange);
}

// ── Kind + trigger-kind mapping ─────────────────────────────────

/**
 * LSP `CompletionItemKind` (1-25) → Monaco's. The two enums do NOT use the
 * same numbers, so this table is load-bearing: without it every item renders
 * with the wrong icon and sorts into the wrong group.
 *
 * An unrecognised kind maps to Text rather than being dropped — a server that
 * invents a kind should lose its icon, not its item.
 */
export function mapCompletionItemKind(
  lspKind: number | undefined,
  kinds: MonacoCompletionEnums['kinds'],
): number {
  const K = kinds;
  const map: Record<number, number> = {
    1: K.Text, 2: K.Method, 3: K.Function, 4: K.Constructor, 5: K.Field,
    6: K.Variable, 7: K.Class, 8: K.Interface, 9: K.Module, 10: K.Property,
    11: K.Unit, 12: K.Value, 13: K.Enum, 14: K.Keyword, 15: K.Snippet,
    16: K.Color, 17: K.File, 18: K.Reference, 19: K.Folder, 20: K.EnumMember,
    21: K.Constant, 22: K.Struct, 23: K.Event, 24: K.Operator, 25: K.TypeParameter,
  };
  return lspKind != null && map[lspKind] != null ? map[lspKind] : K.Text;
}

/**
 * Monaco `CompletionTriggerKind` → LSP's. Off by one in both directions:
 * Monaco counts from 0 (Invoke), LSP from 1 (Invoked).
 */
export function toLspCompletionTriggerKind(monacoTriggerKind: number): 1 | 2 | 3 {
  switch (monacoTriggerKind) {
    case 1:
      return 2; // TriggerCharacter
    case 2:
      return 3; // TriggerForIncompleteCompletions
    default:
      return 1; // Invoke
  }
}

// ── Item mapping ────────────────────────────────────────────────

function documentationOf(
  doc: LspCompletionItem['documentation'],
): { value: string } | undefined {
  if (!doc) return undefined;
  return typeof doc === 'string' ? { value: doc } : { value: doc.value };
}

/** The plain-text label, whatever shape the server sent it in. */
export function labelText(label: LspCompletionItem['label']): string {
  return typeof label === 'string' ? label : label.label;
}

/**
 * One LSP item → one Monaco suggestion.
 *
 * `wordRange` is the fallback for an item with no `textEdit` and no default
 * `editRange`. Monaco requires a range on every suggestion because the range
 * is what the item replaces; servers routinely omit it, and the word under the
 * cursor is what VS Code's own client substitutes.
 */
export function toMonacoCompletionItem(
  item: LspCompletionItem,
  wordRange: MonacoRange,
  enums: MonacoCompletionEnums,
  defaults?: LspItemDefaults,
): MonacoSuggestion {
  const label = labelText(item.label);

  const range: MonacoInsertRange = item.textEdit
    ? editRangeToMonaco(item.textEdit)
    : defaults?.editRange
      ? editRangeToMonaco(defaults.editRange)
      : wordRange;

  const insertTextFormat = item.insertTextFormat ?? defaults?.insertTextFormat;
  const commitCharacters = item.commitCharacters ?? defaults?.commitCharacters;

  const tags =
    item.tags?.includes(1) || item.deprecated ? [enums.deprecatedTag] : undefined;

  const additionalTextEdits = item.additionalTextEdits?.map((edit) => ({
    range: toMonacoRange(edit.range),
    text: edit.newText,
  }));

  return {
    // Keep the rich label shape when the server sends one — Monaco renders
    // `detail`/`description` beside the name, which is where a C# member's
    // signature and namespace belong.
    label: typeof item.label === 'string' ? item.label : { ...item.label },
    kind: mapCompletionItemKind(item.kind, enums.kinds),
    insertText: item.textEdit?.newText ?? item.insertText ?? label,
    insertTextRules: insertTextFormat === 2 ? enums.insertAsSnippet : undefined,
    detail: item.detail,
    documentation: documentationOf(item.documentation),
    sortText: item.sortText,
    filterText: item.filterText,
    commitCharacters,
    preselect: item.preselect,
    tags,
    range,
    additionalTextEdits,
    // The item as the server sent it, plus any `data` it hoisted into the
    // list defaults. `data` is what a server looks the item up by on resolve,
    // so handing back a copy that lost it makes resolve answer nothing —
    // which, for csharp-ls, is every C# completion losing its signature and
    // documentation.
    _lsp:
      item.data === undefined && defaults?.data !== undefined
        ? { ...item, data: defaults.data }
        : item,
  };
}

/**
 * A whole completion response → what Monaco's provider must return.
 *
 * `incomplete` is the server's own flag unless the profile records that this
 * server lies about it (see `ServerProfile.completionListsAreComplete`).
 */
export function mapCompletionList(
  result: LspCompletionList | LspCompletionItem[] | null,
  wordRange: MonacoRange,
  enums: MonacoCompletionEnums,
  profile: ServerProfile,
): { suggestions: MonacoSuggestion[]; incomplete: boolean } {
  if (!result) return { suggestions: [], incomplete: false };

  const isList = !Array.isArray(result);
  const items = isList ? result.items : result;
  const defaults = isList ? result.itemDefaults : undefined;
  const serverSaysIncomplete = isList ? result.isIncomplete === true : false;

  return {
    suggestions: items.map((item) =>
      toMonacoCompletionItem(item, wordRange, enums, defaults),
    ),
    incomplete: profile.completionListsAreComplete ? false : serverSaysIncomplete,
  };
}

/**
 * Fold a `completionItem/resolve` response into the suggestion already on
 * screen. Only the fields a server may fill in late are taken, and only when
 * it actually sent them — a resolve that answers with less than the original
 * must not blank the widget.
 */
export function mergeResolvedItem(
  current: MonacoSuggestion,
  resolved: LspCompletionItem | null | undefined,
): MonacoSuggestion {
  if (!resolved) return current;
  const documentation = documentationOf(resolved.documentation);
  // `additionalTextEdits` is the field this matters most for: a server that
  // computes imports lazily sends the `using` directive only on resolve, and
  // accepting the item without it inserts a name nothing declares.
  const additionalTextEdits = resolved.additionalTextEdits?.map((edit) => ({
    range: {
      startLineNumber: edit.range.start.line + 1,
      startColumn: edit.range.start.character + 1,
      endLineNumber: edit.range.end.line + 1,
      endColumn: edit.range.end.character + 1,
    },
    text: edit.newText,
  }));
  return {
    ...current,
    detail: resolved.detail ?? current.detail,
    documentation: documentation ?? current.documentation,
    additionalTextEdits: additionalTextEdits ?? current.additionalTextEdits,
  };
}

// ── Position predicates for the static Unity providers ──────────

/** True when the cursor sits directly after a member-access dot. */
export function isAfterDot(lineUntilCursor: string): boolean {
  return /\.\s*$/.test(lineUntilCursor);
}

/**
 * Should the Unity lifecycle snippets be offered here?
 *
 * Each one expands to a COMPLETE declaration (`private void Update() { … }`),
 * so the only position where accepting one produces valid code is a bare
 * member position: indentation, then at most the partial name being typed.
 * Behind an already-typed `private void ` the snippet would paste its own
 * modifiers on top of the user's, and after a `.` a method cannot be declared
 * at all — which is where the ungated version put 31 snippets sorted above
 * every real member (`sortText: '0'…`), in every completion list in the file.
 */
export function shouldOfferLifecycleSnippets(lineUntilCursor: string): boolean {
  return /^\s*[A-Za-z_]*$/.test(lineUntilCursor);
}

/**
 * Drop static suggestions the language server already offered.
 *
 * The fallback lists exist so a user sees something while Roslyn builds its
 * project graph. Once it answers, every name it returns is better than the
 * static copy — scoped, typed and documented — and showing both puts two rows
 * with the same label in the widget.
 */
export function filterStaticSuggestions<T extends { label: string }>(
  staticItems: T[],
  lspLabels: ReadonlySet<string>,
): T[] {
  if (lspLabels.size === 0) return staticItems;
  return staticItems.filter((item) => !lspLabels.has(item.label));
}
