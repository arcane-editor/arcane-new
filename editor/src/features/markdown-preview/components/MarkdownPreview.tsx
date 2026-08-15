import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquarePlus, X } from 'lucide-react';
import { createNote, reanchorNotes, type PlanNote } from '../services/note-anchor';

// Hoisted: react-markdown treats a fresh array as a plugin change and re-parses
// the whole document on every render.
const REMARK_PLUGINS = [remarkGfm];

interface MarkdownPreviewProps {
  content: string;
  notes: PlanNote[];
  onNotesChange: (notes: PlanNote[]) => void;
  /** Read-only preview (a non-plan .md) hides the suggest affordance. */
  allowNotes?: boolean;
  /**
   * Notion-style in-place block editing: click a paragraph/heading/list item
   * to edit its raw markdown, click a checkbox to toggle it. Commits go
   * through the callbacks below (offsets are AST source offsets on `content`).
   */
  editable?: boolean;
  onCommitBlockEdit?: (start: number, end: number, newText: string) => void;
  onToggleTask?: (offset: number) => void;
}

interface PendingSelection {
  text: string;
  x: number;
  y: number;
}

interface EditingBlock {
  start: number;
  end: number;
  /** The slice at edit-start — commit is dropped if the document moved under us. */
  original: string;
}

/** The subset of the hast node shape the block components need. */
interface PositionedNode {
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
}

function offsetsOf(node: PositionedNode | undefined): { start: number; end: number } | null {
  const start = node?.position?.start?.offset;
  const end = node?.position?.end?.offset;
  if (typeof start !== 'number' || typeof end !== 'number' || end <= start) return null;
  return { start, end };
}

/**
 * Rendered markdown with select-to-suggest and (for plans) click-to-edit.
 *
 * Select any text and a "Suggest change" affordance appears; the note is
 * pinned to that text rather than to an offset, so it survives the model
 * rewriting the document. A plain CLICK (collapsed selection) on a block
 * enters edit mode for that block when `editable` — selection always wins
 * over editing, so suggest keeps working. Raw HTML stays disabled (no
 * rehype-raw) — this renders model output.
 */
function MarkdownPreview({
  content,
  notes,
  onNotesChange,
  allowNotes = true,
  editable = false,
  onCommitBlockEdit,
  onToggleTask,
}: MarkdownPreviewProps) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [draft, setDraft] = useState('');
  const [editing, setEditing] = useState<EditingBlock | null>(null);
  const [editDraft, setEditDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);
  const editRef = useRef<HTMLTextAreaElement>(null);

  // Re-locate notes whenever the document changes — a revise rewrites it all.
  useEffect(() => {
    const next = reanchorNotes(notes, content);
    const changed = next.some((n, i) => n.anchored !== notes[i]?.anchored || n.headingPath !== notes[i]?.headingPath);
    if (changed) onNotesChange(next);
    // Intentionally keyed on `content` alone: re-running on `notes` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // Losing editability mid-edit (execution started) discards the in-progress edit.
  useEffect(() => {
    if (!editable) setEditing(null);
  }, [editable]);

  useEffect(() => {
    if (editing) editRef.current?.focus();
  }, [editing]);

  const onMouseUp = useCallback(() => {
    if (!allowNotes) return;
    const sel = window.getSelection();
    const text = sel?.toString().trim() ?? '';
    // A stray click clears the selection; only a real range opens the popover.
    if (!sel || sel.isCollapsed || text.length < 2) {
      setPending(null);
      return;
    }
    if (!bodyRef.current?.contains(sel.anchorNode)) return;

    const rect = sel.getRangeAt(0).getBoundingClientRect();
    setPending({ text, x: rect.left + rect.width / 2, y: rect.bottom + 6 });
  }, [allowNotes]);

  useEffect(() => {
    if (!pending) return;
    draftRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setPending(null);
        setDraft('');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [pending]);

  function addNote() {
    if (!pending || !draft.trim()) return;
    onNotesChange([...notes, createNote(content, pending.text, draft.trim())]);
    setPending(null);
    setDraft('');
    window.getSelection()?.removeAllRanges();
  }

  function beginBlockEdit(node: PositionedNode | undefined, e: React.MouseEvent) {
    if (!editable || !onCommitBlockEdit) return;
    // A real selection means the user is suggesting, not editing.
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return;
    // Interactive elements keep their own behavior (checkbox toggle, links).
    const target = e.target as HTMLElement;
    if (target.closest('input, a, textarea')) return;
    const range = offsetsOf(node);
    if (!range) return;
    e.stopPropagation(); // a p inside an li must not also start the li's edit
    setEditing({ ...range, original: content.slice(range.start, range.end) });
    setEditDraft(content.slice(range.start, range.end));
  }

  function commitBlockEdit() {
    if (!editing) return;
    const { start, end, original } = editing;
    setEditing(null);
    // Stale guard: the agent (or a reload) rewrote the file under the editor —
    // drop the edit rather than splice at offsets that no longer mean anything.
    if (content.slice(start, end) !== original) return;
    if (editDraft === original) return;
    onCommitBlockEdit?.(start, end, editDraft);
  }

  function editorFor(editingBlock: EditingBlock): React.ReactNode {
    return (
      <textarea
        ref={editRef}
        className="md-block-editing"
        value={editDraft}
        rows={Math.max(1, editDraft.split('\n').length)}
        onChange={(e) => setEditDraft(e.target.value)}
        onBlur={commitBlockEdit}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            commitBlockEdit();
          } else if (e.key === 'Escape') {
            setEditing(null);
          }
        }}
        aria-label="Edit block markdown"
        data-editing-start={editingBlock.start}
      />
    );
  }

  // Every note's quoted text, so the renderer can highlight them.
  const highlighted = useMemo(
    () => new Set(notes.filter((n) => n.anchored).map((n) => n.quotedText)),
    [notes],
  );

  const markdownComponents = useMemo(() => {
    type BlockProps = { node?: PositionedNode; children?: React.ReactNode };

    const isEditingNode = (node?: PositionedNode) => {
      const range = offsetsOf(node);
      return !!editing && !!range && range.start === editing.start && range.end === editing.end;
    };

    /** Clickable-to-edit block that also carries the note highlight. */
    const block =
      (Tag: 'p' | 'li' | 'h1' | 'h2' | 'h3' | 'h4', highlight: boolean) =>
      ({ node, children }: BlockProps) => {
        if (editable && isEditingNode(node) && editing) {
          // The textarea replaces the block's CONTENT, keeping the tag so list
          // markers/semantics stay stable while editing an li.
          return <Tag className="md-block-editing-host">{editorFor(editing)}</Tag>;
        }
        return (
          <Tag
            onClick={editable ? (e: React.MouseEvent) => beginBlockEdit(node, e) : undefined}
            className={editable ? 'md-block-editable' : undefined}
          >
            {highlight ? highlightRun(children, highlighted) : children}
          </Tag>
        );
      };

    return {
      // Mark up text that a note is pinned to. Only exact runs are wrapped —
      // partial highlighting would need range surgery the renderer cannot do
      // safely, and a missed highlight is far better than mangled prose.
      p: block('p', true),
      li: block('li', true),
      h1: block('h1', false),
      h2: block('h2', false),
      h3: block('h3', false),
      h4: block('h4', false),
      // Task-list checkboxes: live when editable (remark-gfm renders them
      // disabled), toggling `- [ ]`/`- [x]` in the source via the li's line.
      input: ({ node, ...props }: BlockProps & { type?: string; checked?: boolean; disabled?: boolean }) => {
        const rest = props as React.InputHTMLAttributes<HTMLInputElement>;
        if (!editable || !onToggleTask || rest.type !== 'checkbox') {
          return <input {...rest} />;
        }
        const start = node?.position?.start?.offset;
        return (
          <input
            {...rest}
            disabled={false}
            onChange={() => {
              if (typeof start === 'number') onToggleTask(start);
            }}
          />
        );
      },
    };
    // beginBlockEdit/commitBlockEdit/editorFor close over content/editing/editDraft;
    // memo keys cover everything that changes their behavior.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [highlighted, editable, editing, editDraft, content, onCommitBlockEdit, onToggleTask]);

  return (
    <div className="md-preview" onMouseUp={onMouseUp}>
      <div className="md-preview-body" ref={bodyRef}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {content}
        </Markdown>
      </div>

      {pending && (
        <div className="md-suggest-popover" style={{ left: pending.x, top: pending.y }}>
          <div className="md-suggest-quote">“{truncate(pending.text, 80)}”</div>
          <textarea
            ref={draftRef}
            className="md-suggest-input"
            placeholder="What should change?"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              // Enter submits; Shift+Enter is a newline. Matches the composer.
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                addNote();
              }
            }}
          />
          <div className="md-suggest-actions">
            <button type="button" className="md-suggest-btn" onClick={() => { setPending(null); setDraft(''); }}>
              Cancel
            </button>
            <button
              type="button"
              className="md-suggest-btn md-suggest-btn--primary"
              onClick={addNote}
              disabled={!draft.trim()}
            >
              Add
            </button>
          </div>
        </div>
      )}

      {notes.length > 0 && (
        <div className="md-notes">
          <div className="md-notes-title">
            {notes.length} suggestion{notes.length === 1 ? '' : 's'}
          </div>
          {notes.map((n) => (
            <div key={n.id} className={`md-note${n.anchored ? '' : ' md-note--orphan'}`}>
              <div className="md-note-head">
                <span className="md-note-heading">{n.headingPath || 'Document'}</span>
                {!n.anchored && (
                  <span
                    className="md-note-orphan-tag"
                    title="The text this was pinned to is no longer in the plan. Your note is kept."
                  >
                    text changed
                  </span>
                )}
                <button
                  type="button"
                  className="md-note-remove"
                  aria-label="Remove suggestion"
                  onClick={() => onNotesChange(notes.filter((x) => x.id !== n.id))}
                >
                  <X size={11} />
                </button>
              </div>
              <div className="md-note-quote">“{truncate(n.quotedText, 90)}”</div>
              <div className="md-note-body">{n.body}</div>
            </div>
          ))}
        </div>
      )}

      {allowNotes && notes.length === 0 && (
        <div className="md-preview-hint">
          <MessageSquarePlus size={12} />
          {editable ? 'Click a block to edit it, or select text to suggest a change.' : 'Select any text to suggest a change.'}
        </div>
      )}
    </div>
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

/** Wrap exact runs of noted text in a mark element. */
function highlightRun(children: React.ReactNode, needles: Set<string>): React.ReactNode {
  if (needles.size === 0) return children;
  if (typeof children !== 'string') return children;
  for (const needle of needles) {
    const i = children.indexOf(needle);
    if (i === -1) continue;
    return (
      <>
        {children.slice(0, i)}
        <mark className="md-note-mark">{needle}</mark>
        {children.slice(i + needle.length)}
      </>
    );
  }
  return children;
}

export default MarkdownPreview;
