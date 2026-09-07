/**
 * One editable region of a plan, rendered as itself.
 *
 * This replaces the click-to-edit textarea the plan view used to swap in over
 * a rendered block. That pattern is what made editing a plan feel like filling
 * in a form: a click replaced formatted text with a box of raw markdown, so
 * `**bold**` went back to asterisks, the caret could not leave the box, and
 * every edit was a modal little transaction that committed on blur.
 *
 * Here the rendered text IS the editor. Lexical holds the region's markdown as
 * nodes, styles them live, and serializes back to markdown on change
 * (`region-markdown.ts`); the parent splices that back into the file by offset.
 * Structure keys — `T<n>` ids, `[easy|hard]` tags, `### T<n>` guide headings,
 * the `## Todos` skeleton — are outside every region's range by construction
 * (`region-model.ts`), so no amount of typing in here can reach them.
 *
 * One editor per region, not one per document: `$convertToMarkdownString`
 * normalizes whatever it serializes, and a document-wide editor would rewrite
 * the whole `.aplan` — bookkeeping included — on every keystroke.
 *
 * A TITLE region runs on inline transformers only. It is the text of one
 * checkbox line, so block syntax has no meaning there — typing `- ` at the
 * start of a title leaves a hyphen instead of turning the row into a list —
 * while `code`, **bold** and *italic* still render, because plan titles are
 * mostly identifiers and reading them as code is what makes them scannable.
 */

import { memo, useCallback, useEffect, useRef } from 'react';
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { HistoryPlugin } from '@lexical/react/LexicalHistoryPlugin';
import { OnChangePlugin } from '@lexical/react/LexicalOnChangePlugin';
import { ListPlugin } from '@lexical/react/LexicalListPlugin';
import { CheckListPlugin } from '@lexical/react/LexicalCheckListPlugin';
import { MarkdownShortcutPlugin } from '@lexical/react/LexicalMarkdownShortcutPlugin';
import {
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $isParagraphNode,
  $selectAll,
  BLUR_COMMAND,
  COMMAND_PRIORITY_LOW,
  FOCUS_COMMAND,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_BACKSPACE_COMMAND,
  KEY_ENTER_COMMAND,
  type LexicalEditor,
} from 'lexical';
import { mergeRegister } from '@lexical/utils';
import { $convertFromMarkdownString } from '@lexical/markdown';
import {
  PLAN_EDITOR_NODES,
  PLAN_TITLE_TRANSFORMERS,
  PLAN_TRANSFORMERS,
  exportRegionMarkdown,
  exportTitleMarkdown,
  importRegionMarkdown,
  importTitleMarkdown,
} from '../services/region-markdown';
import { resolveBoundary, type NavIntent } from '../services/region-nav';
import type { PlanRegion, PlanRegionKind } from '../services/region-model';

/** Where the caret goes when another region hands focus here. */
export type CaretTarget = 'start' | 'end' | 'all';

export type RegionFocuser = (caret: CaretTarget) => void;

interface Props {
  regionId: string;
  kind: PlanRegionKind;
  /** The region's body markdown — LF, no surrounding blank lines. */
  text: string;
  editable: boolean;
  /** Every region of the current parse, for boundary hand-off. */
  regions: readonly PlanRegion[];
  /** True when this region's whole step (title + guide) is empty. */
  stepIsEmpty: boolean;
  placeholder?: string;
  ariaLabel: string;
  onChange: (regionId: string, body: string) => void;
  onNavIntent: (regionId: string, intent: NavIntent) => void;
  /** Blur is the cheap moment to force a pending disk write out. */
  onBlur: () => void;
  registerFocuser: (regionId: string, focus: RegionFocuser | null) => void;
}

/** Replace the editor's contents with `text`, in the mode this region uses. */
function loadInto(editor: LexicalEditor, text: string, kind: PlanRegionKind): void {
  if (kind === 'title') importTitleMarkdown(editor, text);
  else importRegionMarkdown(editor, text);
}

function PlanRegionEditor(props: Props) {
  const { regionId, kind, text, editable, ariaLabel, placeholder } = props;

  const initialConfig = {
    // Namespaced per region so Lexical's own dev warnings name the right one.
    namespace: `plan-region-${regionId}`,
    nodes: PLAN_EDITOR_NODES,
    editable,
    editorState: () => {
      $convertFromMarkdownString(
        text,
        kind === 'title' ? PLAN_TITLE_TRANSFORMERS : PLAN_TRANSFORMERS,
      );
    },
    // A region whose markdown Lexical cannot represent must not take the whole
    // plan view down: log it and keep whatever the editor managed to build.
    onError: (error: Error) => {
      console.error(`Plan region ${regionId} failed:`, error);
    },
    theme: REGION_THEME,
  };

  // `placeholder` and `aria-placeholder` are required together by
  // ContentEditable's props; an empty one renders nothing, which is what a
  // region with no placeholder wants.
  const content = (
    <ContentEditable
      className={`plan-region-content plan-region-content--${kind}`}
      aria-label={ariaLabel}
      aria-placeholder={placeholder ?? ''}
      placeholder={<div className="plan-region-placeholder">{placeholder ?? ''}</div>}
      spellCheck={false}
      autoCorrect="off"
      autoCapitalize="off"
      data-gramm={false}
    />
  );

  return (
    <div className={`plan-region plan-region--${kind} md-preview-body`}>
      <LexicalComposer initialConfig={initialConfig}>
        {kind === 'title' ? (
          <>
            <RichTextPlugin contentEditable={content} ErrorBoundary={LexicalErrorBoundary} />
            {/* Inline formats only. A title keeps its `identifiers` as code —
                plan titles are mostly identifiers — but `- ` and `## ` typed
                at the front of one stay literal, because a title is a single
                checkbox row and cannot become a list or a heading. */}
            <MarkdownShortcutPlugin transformers={PLAN_TITLE_TRANSFORMERS} />
          </>
        ) : (
          <>
            <RichTextPlugin contentEditable={content} ErrorBoundary={LexicalErrorBoundary} />
            <ListPlugin />
            <CheckListPlugin />
            {/* `## `, `- `, `- [ ] `, `**bold**`, `` `code` `` applied as typed. */}
            <MarkdownShortcutPlugin transformers={PLAN_TRANSFORMERS} />
          </>
        )}
        <HistoryPlugin />
        <RegionStatePlugin {...props} />
      </LexicalComposer>
    </div>
  );
}

/**
 * Everything that needs the editor instance: serialization out, external text
 * in, focus registration, and the boundary keys.
 *
 * One plugin rather than four so the `focused` flag they all consult is a
 * single ref rather than shared state passed between siblings.
 */
function RegionStatePlugin({
  regionId,
  kind,
  text,
  editable,
  regions,
  stepIsEmpty,
  onChange,
  onNavIntent,
  onBlur,
  registerFocuser,
}: Props) {
  const [editor] = useLexicalComposerContext();

  /** This region's markdown as THIS editor writes it. */
  const serialize = useCallback(
    () => (kind === 'title' ? exportTitleMarkdown(editor) : exportRegionMarkdown(editor)),
    [editor, kind],
  );

  /**
   * What the editor would write for the text it was given — deliberately not
   * the text itself.
   *
   * Lexical normalizes some markdown on the way in (a heading comes back with
   * the blank line after it that the file may not have had). Comparing an
   * edit against the RAW text would report that normalization as a change the
   * moment an editor mounted, and merely opening a plan would rewrite it.
   * Seeded from the state `LexicalComposer` has already built by the time this
   * plugin renders, so the first update — Lexical's own initial flush — is
   * correctly seen as no edit at all.
   */
  const baselineRef = useRef<string | null>(null);
  if (baselineRef.current === null) baselineRef.current = serialize();

  /** The last text this editor accepted FROM the file. */
  const sourceRef = useRef(text);
  const focusedRef = useRef(false);
  // The boundary handler is registered once; these keep it reading live values
  // instead of the ones captured when it was registered.
  const navRef = useRef({ regions, stepIsEmpty, onNavIntent });
  navRef.current = { regions, stepIsEmpty, onNavIntent };

  useEffect(() => {
    editor.setEditable(editable);
  }, [editor, editable]);

  const handleChange = useCallback(() => {
    const next = serialize();
    // Serialization is not a write (see `baselineRef`).
    if (next === baselineRef.current) return;
    baselineRef.current = next;
    // The file is about to say this, so the prop coming back must not read as
    // an external change and re-import over the user's caret.
    sourceRef.current = next;
    onChange(regionId, next);
  }, [onChange, regionId, serialize]);

  // The file moved under us — a revise rewrote the plan, the watcher reloaded
  // it, the executor ticked a step off. Take the new text, unless the user is
  // typing in this very region, where their in-flight text wins until they
  // leave (the same call the old stale-guard made, minus the silent discard).
  useEffect(() => {
    if (text === sourceRef.current) return;
    if (focusedRef.current) return;
    sourceRef.current = text;
    loadInto(editor, text, kind);
    baselineRef.current = serialize();
  }, [editor, text, kind, serialize]);

  useEffect(() => {
    const focus: RegionFocuser = (caret) => {
      editor.focus(() => {
        editor.update(() => {
          const root = $getRoot();
          if (caret === 'all') $selectAll();
          else if (caret === 'start') root.selectStart();
          else root.selectEnd();
        });
      });
    };
    registerFocuser(regionId, focus);
    return () => registerFocuser(regionId, null);
  }, [editor, regionId, registerFocuser]);

  useEffect(
    () =>
      mergeRegister(
        editor.registerCommand(
          FOCUS_COMMAND,
          () => {
            focusedRef.current = true;
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        editor.registerCommand(
          BLUR_COMMAND,
          () => {
            focusedRef.current = false;
            onBlur();
            return false;
          },
          COMMAND_PRIORITY_LOW,
        ),
        ...(
          [
            [KEY_ENTER_COMMAND, 'Enter'],
            [KEY_BACKSPACE_COMMAND, 'Backspace'],
            [KEY_ARROW_UP_COMMAND, 'ArrowUp'],
            [KEY_ARROW_DOWN_COMMAND, 'ArrowDown'],
          ] as const
        ).map(([command, key]) =>
          editor.registerCommand(
            command,
            (event: KeyboardEvent | null) => {
              const live = navRef.current;
              const intent = editor.getEditorState().read(() =>
                resolveBoundary({
                  regions: live.regions,
                  regionId,
                  key,
                  ...boundaryFacts(),
                  stepIsEmpty: live.stepIsEmpty,
                }),
              );
              if (intent.kind === 'default') return false;
              event?.preventDefault();
              if (intent.kind !== 'consume') live.onNavIntent(regionId, intent);
              return true;
            },
            // LOW runs ahead of rich-text's own handlers (registered at EDITOR
            // priority) but behind the list plugin's, so Enter on an empty list
            // item still leaves the list first and only promotes on the next
            // press — one gesture per keystroke, like Notion.
            COMMAND_PRIORITY_LOW,
          ),
        ),
      ),
    [editor, regionId, onBlur],
  );

  return <OnChangePlugin ignoreSelectionChange onChange={handleChange} />;
}

/**
 * Where the caret is, in the terms `resolveBoundary` asks about. Must run
 * inside an editor state read.
 */
function boundaryFacts(): {
  collapsed: boolean;
  atStart: boolean;
  atEnd: boolean;
  atFirstLine: boolean;
  atLastLine: boolean;
  onEmptyTrailingLine: boolean;
  regionIsEmpty: boolean;
} {
  const blank = {
    collapsed: false,
    atStart: false,
    atEnd: false,
    atFirstLine: false,
    atLastLine: false,
    onEmptyTrailingLine: false,
    regionIsEmpty: false,
  };
  const selection = $getSelection();
  if (!$isRangeSelection(selection)) return blank;

  const root = $getRoot();
  const anchorNode = selection.anchor.getNode();
  const block = anchorNode.getTopLevelElement();
  const first = root.getFirstDescendant();
  const last = root.getLastDescendant();
  const lastBlock = root.getLastChild();

  return {
    collapsed: selection.isCollapsed(),
    atStart: selection.anchor.offset === 0 && (first === null || anchorNode.is(first)),
    atEnd:
      last !== null && anchorNode.is(last) && selection.anchor.offset === last.getTextContentSize(),
    atFirstLine: block !== null && block.is(root.getFirstChild()),
    atLastLine: block !== null && block.is(lastBlock),
    // Only a PARAGRAPH counts: an empty list item means "leave the list",
    // which the list plugin handles, not "start the next step".
    onEmptyTrailingLine:
      block !== null &&
      block.is(lastBlock) &&
      $isParagraphNode(block) &&
      block.getTextContent().trim() === '',
    regionIsEmpty: root.getTextContent().trim() === '',
  };
}

/**
 * Class names for Lexical's nodes.
 *
 * The editor renders inside `md-preview-body`, so the element selectors that
 * already style rendered markdown (p, li, h1-h4, code, blockquote) apply
 * unchanged — nothing moves when a region becomes editable. Only the nodes
 * with no plain-HTML equivalent need a class of their own.
 */
const REGION_THEME = {
  paragraph: 'md-lex-p',
  quote: 'md-lex-quote',
  heading: {
    h1: 'md-lex-h1',
    h2: 'md-lex-h2',
    h3: 'md-lex-h3',
    h4: 'md-lex-h4',
  },
  list: {
    ul: 'md-lex-ul',
    ol: 'md-lex-ol',
    listitem: 'md-lex-li',
    listitemChecked: 'md-lex-li-checked',
    listitemUnchecked: 'md-lex-li-unchecked',
    nested: { listitem: 'md-lex-li-nested' },
  },
  text: {
    bold: 'md-lex-bold',
    italic: 'md-lex-italic',
    code: 'md-lex-code',
    strikethrough: 'md-lex-strike',
  },
  code: 'md-lex-codeblock',
  link: 'md-lex-link',
};

/**
 * Memoized on the region's own text, not the document's.
 *
 * This is the second half of the sluggishness fix: a keystroke in one step's
 * guide changes the whole document string, and every region used to re-render
 * (and re-parse its markdown) because its props were rebuilt from it. Regions
 * now take only their own slice, so an untouched one bails here.
 */
export default memo(PlanRegionEditor, (a, b) => {
  return (
    a.regionId === b.regionId &&
    a.text === b.text &&
    a.editable === b.editable &&
    a.kind === b.kind &&
    a.stepIsEmpty === b.stepIsEmpty &&
    a.regions === b.regions &&
    a.placeholder === b.placeholder &&
    a.ariaLabel === b.ariaLabel &&
    a.onChange === b.onChange &&
    a.onNavIntent === b.onNavIntent &&
    a.onBlur === b.onBlur &&
    a.registerFocuser === b.registerFocuser
  );
});
