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
}

interface PendingSelection {
  text: string;
  x: number;
  y: number;
}

/**
 * Rendered markdown with select-to-suggest.
 *
 * Select any text and a "Suggest change" affordance appears; the note is
 * pinned to that text rather than to an offset, so it survives the model
 * rewriting the document. Raw HTML stays disabled (no rehype-raw) — this
 * renders model output.
 */
function MarkdownPreview({ content, notes, onNotesChange, allowNotes = true }: MarkdownPreviewProps) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [draft, setDraft] = useState('');
  const bodyRef = useRef<HTMLDivElement>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  // Re-locate notes whenever the document changes — a revise rewrites it all.
  useEffect(() => {
    const next = reanchorNotes(notes, content);
    const changed = next.some((n, i) => n.anchored !== notes[i]?.anchored || n.headingPath !== notes[i]?.headingPath);
    if (changed) onNotesChange(next);
    // Intentionally keyed on `content` alone: re-running on `notes` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

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

  // Every note's quoted text, so the renderer can highlight them.
  const highlighted = useMemo(
    () => new Set(notes.filter((n) => n.anchored).map((n) => n.quotedText)),
    [notes],
  );

  const markdownComponents = useMemo(
    () => ({
      // Mark up text that a note is pinned to. Only exact runs are wrapped —
      // partial highlighting would need range surgery the renderer cannot do
      // safely, and a missed highlight is far better than mangled prose.
      p: ({ children }: { children?: React.ReactNode }) => (
        <p>{highlightRun(children, highlighted)}</p>
      ),
      li: ({ children }: { children?: React.ReactNode }) => (
        <li>{highlightRun(children, highlighted)}</li>
      ),
    }),
    [highlighted],
  );

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
          Select any text to suggest a change.
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
