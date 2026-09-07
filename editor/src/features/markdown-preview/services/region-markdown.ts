/**
 * Markdown in, Lexical nodes out — and back again, byte for byte.
 *
 * The plan view edits a region's TEXT through a Lexical editor, but the file on
 * disk stays the markdown the model wrote and the executor reads. Everything
 * that keeps those two facts compatible lives here.
 *
 * Three rules, each of which cost a bug the first time it was missing:
 *
 * 1. **Only the body travels.** A region's range includes the blank lines
 *    around it. Those bytes are spacing, not the user's text; `splitRegionText`
 *    holds them aside and `joinRegionText` puts them back verbatim, so a region
 *    the user opened but did not change splices back identical to what it was.
 * 2. **CRLF never reaches Lexical.** It has no concept of one — a document
 *    saved with CRLF would come back mixed. The body is normalized to LF on the
 *    way in and restored on the way out, the same preservation `todo-edit.ts`
 *    does for its own rewrites.
 * 3. **Serialization is not a write.** `$convertToMarkdownString` normalizes
 *    whatever it touches, so the caller compares against the baseline captured
 *    at import and writes only when the user actually changed something. That
 *    is what confines normalization to regions someone is typing in.
 *
 * `roundTripRegion` is the honest test of all three, and needs no DOM: Lexical
 * only reconciles to the DOM when an editor has a root element, so
 * `createEditor()` + a discrete update runs under plain `bun test` — which is
 * why this module can be tested at all (`region-markdown.test.ts`), the same
 * pure-service convention every other service in this feature follows.
 */

import { createEditor, type LexicalEditor } from 'lexical';
import {
  $convertFromMarkdownString,
  $convertToMarkdownString,
  TEXT_FORMAT_TRANSFORMERS,
  TRANSFORMERS,
} from '@lexical/markdown';
import { HeadingNode, QuoteNode } from '@lexical/rich-text';
import { ListNode, ListItemNode } from '@lexical/list';
// `@lexical/code-core`, not `@lexical/code`: 0.44 split the node classes out of
// the syntax-highlighting package, and code-core is what `@lexical/markdown`
// itself depends on — the only one of the two actually installed here.
import { CodeNode, CodeHighlightNode } from '@lexical/code-core';
import { LinkNode } from '@lexical/link';

/**
 * The node set every plan editor registers. Anything a transformer can produce
 * MUST be here — Lexical throws on an unregistered node, and in an editor over
 * model-written markdown that throw would land mid-render.
 */
export const PLAN_EDITOR_NODES = [
  HeadingNode,
  QuoteNode,
  ListNode,
  ListItemNode,
  CodeNode,
  CodeHighlightNode,
  LinkNode,
];

/**
 * Lexical's stock set: headings, quote, lists (including `- [ ]` task lists via
 * CHECK_LIST), fenced code, links, and the inline formats. It carries no table
 * or image transformer, which is the right shape for a plan — those are the two
 * constructs whose round trip is lossy, and a plan has no use for either.
 */
export const PLAN_TRANSFORMERS = TRANSFORMERS;

/**
 * What a step TITLE may contain.
 *
 * A title is one line of a checkbox row, so block syntax has no meaning there:
 * typing `- ` or `## ` at the front must leave a hyphen or a hash, not turn
 * the row into a list. Inline formatting stays, because plan titles are mostly
 * identifiers — `GET /b2b/domain/:domainName`, `MonoBehaviour` — and reading
 * them as code is the difference between a title and a sentence.
 */
export const PLAN_TITLE_TRANSFORMERS = TEXT_FORMAT_TRANSFORMERS;

/** Replace a title editor's contents. */
export function importTitleMarkdown(editor: LexicalEditor, md: string): void {
  editor.update(
    () => {
      $convertFromMarkdownString(md, PLAN_TITLE_TRANSFORMERS);
    },
    { discrete: true },
  );
}

/**
 * A title editor's markdown, forced onto ONE line.
 *
 * Pasting two paragraphs into a title would otherwise splice a newline into
 * the middle of a `- [ ]` row and split one step into a step and a stray line
 * of prose.
 */
export function exportTitleMarkdown(editor: LexicalEditor): string {
  return editor
    .getEditorState()
    .read(() => $convertToMarkdownString(PLAN_TITLE_TRANSFORMERS))
    .replace(/\s*[\r\n]+\s*/g, ' ')
    .trim();
}

export interface RegionText {
  /** Whitespace before the body, kept out of the editor and restored on write. */
  leading: string;
  /** The user's text, always LF-normalized. */
  body: string;
  /** Whitespace after the body — the blank line before the next block. */
  trailing: string;
  /** What the region's line breaks were in the file. */
  eol: '\n' | '\r\n';
}

/** Split a region's raw slice into padding + body, LF-normalizing the body. */
export function splitRegionText(src: string): RegionText {
  const eol: '\n' | '\r\n' = src.includes('\r\n') ? '\r\n' : '\n';
  const trimmedStart = src.trimStart();
  const leading = src.slice(0, src.length - trimmedStart.length);
  const body = trimmedStart.trimEnd();
  const trailing = src.slice(leading.length + body.length);
  return { leading, body: body.replace(/\r\n/g, '\n'), trailing, eol };
}

/** Put an edited body back inside the padding it came from. */
export function joinRegionText(part: RegionText, body: string): string {
  const withEol = part.eol === '\r\n' ? body.replace(/\n/g, '\r\n') : body;
  return `${part.leading}${withEol}${part.trailing}`;
}

/** Replace an editor's whole contents with `md`. */
export function importRegionMarkdown(editor: LexicalEditor, md: string): void {
  editor.update(
    () => {
      $convertFromMarkdownString(md, PLAN_TRANSFORMERS);
    },
    { discrete: true },
  );
}

/** The markdown an editor's current state serializes to. */
export function exportRegionMarkdown(editor: LexicalEditor): string {
  return editor.getEditorState().read(() => $convertToMarkdownString(PLAN_TRANSFORMERS));
}

/** A throwaway editor, for the round-trip checks below. */
function scratchEditor(): LexicalEditor {
  return createEditor({
    namespace: 'plan-region-round-trip',
    nodes: PLAN_EDITOR_NODES,
    // A malformed region must not take the view down with it: the caller keeps
    // the original text when this throws.
    onError: (error: Error) => {
      throw error;
    },
  });
}

/**
 * What `md` becomes after a trip through the editor — the baseline a caller
 * compares against to tell a real edit from mere re-serialization, and the
 * fidelity check the tests are built on.
 */
export function roundTripRegion(md: string): string {
  if (!md.trim()) return '';
  const editor = scratchEditor();
  importRegionMarkdown(editor, md);
  return exportRegionMarkdown(editor);
}

/** The same, for a step title's inline-only transformer set. */
export function roundTripTitle(md: string): string {
  if (!md.trim()) return '';
  const editor = scratchEditor();
  importTitleMarkdown(editor, md);
  return exportTitleMarkdown(editor);
}
