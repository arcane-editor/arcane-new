/**
 * Select text, say what should change about it.
 *
 * Extracted from `MarkdownPreview` so the plan view can keep this affordance
 * now that its text lives in Lexical editors rather than in a rendered
 * preview. Both surfaces bind it to a container element and hand it the WHOLE
 * document to anchor against — a note is pinned to its quoted text, not to an
 * offset, so it survives the model rewriting the plan (`note-anchor.ts`).
 *
 * It listens on the container rather than taking an `onMouseUp` prop because
 * the plan view's regions are many small editors: one listener on the page
 * covers every one of them, including selections dragged across two.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { createNote, type PlanNote } from '../services/note-anchor';

interface PendingSelection {
  text: string;
  x: number;
  y: number;
}

interface Props {
  /** Selections inside this element open the popover. */
  containerRef: React.RefObject<HTMLElement | null>;
  /** The document a note's quote is resolved against. */
  anchorDoc: string;
  notes: PlanNote[];
  onNotesChange: (notes: PlanNote[]) => void;
  /** Off while a plan is executing, and for plain read-only previews. */
  enabled: boolean;
}

function SuggestPopover({ containerRef, anchorDoc, notes, onNotesChange, enabled }: Props) {
  const [pending, setPending] = useState<PendingSelection | null>(null);
  const [draft, setDraft] = useState('');
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const host = containerRef.current;
    if (!host || !enabled) return;

    const onMouseUp = () => {
      const sel = window.getSelection();
      const text = sel?.toString().trim() ?? '';
      // A stray click clears the selection; only a real range opens the popover.
      if (!sel || sel.isCollapsed || text.length < 2) {
        setPending(null);
        return;
      }
      if (!host.contains(sel.anchorNode)) return;
      const rect = sel.getRangeAt(0).getBoundingClientRect();
      setPending({ text, x: rect.left + rect.width / 2, y: rect.bottom + 6 });
    };

    host.addEventListener('mouseup', onMouseUp);
    return () => host.removeEventListener('mouseup', onMouseUp);
  }, [containerRef, enabled]);

  // Losing the affordance mid-selection (a run started) closes the popover.
  useEffect(() => {
    if (!enabled) setPending(null);
  }, [enabled]);

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

  const addNote = useCallback(() => {
    if (!pending || !draft.trim()) return;
    onNotesChange([...notes, createNote(anchorDoc, pending.text, draft.trim())]);
    setPending(null);
    setDraft('');
    window.getSelection()?.removeAllRanges();
  }, [anchorDoc, draft, notes, onNotesChange, pending]);

  if (!pending) return null;

  return (
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
          // ⌘/Ctrl+Enter submits too, so the habit carries over from the
          // roomier per-step composer without having to think about which box
          // you are in. Escape closes.
          if (e.key === 'Enter' && (!e.shiftKey || e.metaKey || e.ctrlKey)) {
            e.preventDefault();
            addNote();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            setPending(null);
            setDraft('');
          }
        }}
        spellCheck={false}
        autoComplete="off"
        autoCorrect="off"
        autoCapitalize="off"
      />
      <div className="md-suggest-actions">
        <button
          type="button"
          className="md-suggest-btn"
          onClick={() => {
            setPending(null);
            setDraft('');
          }}
        >
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
  );
}

function truncate(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n - 1)}…` : s;
}

export default SuggestPopover;
