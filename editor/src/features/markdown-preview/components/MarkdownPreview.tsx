import { useEffect, useMemo, useRef } from 'react';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { MessageSquarePlus, X } from 'lucide-react';
import SuggestPopover from './SuggestPopover';
import { reanchorNotes, type PlanNote } from '../services/note-anchor';

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

/**
 * Rendered markdown with select-to-suggest.
 *
 * Select any text and a "Suggest change" affordance appears; the note is
 * pinned to that text rather than to an offset, so it survives the model
 * rewriting the document. Raw HTML stays disabled (no rehype-raw) — this
 * renders model output.
 *
 * This used to carry a second job: click-to-edit, which swapped the clicked
 * block for a textarea of its raw markdown and committed on blur. That is gone
 * — a plan is now edited in place through `PlanRegionEditor`, where the
 * rendered text IS the editor and never turns back into source. What is left
 * here is the read-only renderer, which is all a plain `.md` file needs.
 */
function MarkdownPreview({
  content,
  notes,
  onNotesChange,
  allowNotes = true,
}: MarkdownPreviewProps) {
  const bodyRef = useRef<HTMLDivElement>(null);

  // Re-locate notes whenever the document changes — a revise rewrites it all.
  useEffect(() => {
    const next = reanchorNotes(notes, content);
    const changed = next.some(
      (n, i) => n.anchored !== notes[i]?.anchored || n.headingPath !== notes[i]?.headingPath,
    );
    if (changed) onNotesChange(next);
    // Intentionally keyed on `content` alone: re-running on `notes` would loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [content]);

  // Every note's quoted text, so the renderer can highlight them.
  const highlighted = useMemo(
    () => new Set(notes.filter((n) => n.anchored).map((n) => n.quotedText)),
    [notes],
  );

  const markdownComponents = useMemo(() => {
    type BlockProps = { children?: React.ReactNode };

    /** A block that carries the note highlight. */
    const block =
      (Tag: 'p' | 'li') =>
      ({ children }: BlockProps) => <Tag>{highlightRun(children, highlighted)}</Tag>;

    return {
      // Mark up text that a note is pinned to. Only exact runs are wrapped —
      // partial highlighting would need range surgery the renderer cannot do
      // safely, and a missed highlight is far better than mangled prose.
      p: block('p'),
      li: block('li'),
    };
  }, [highlighted]);

  return (
    <div className="md-preview">
      <div className="md-preview-body" ref={bodyRef}>
        <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
          {content}
        </Markdown>
      </div>

      <SuggestPopover
        containerRef={bodyRef}
        anchorDoc={content}
        notes={notes}
        onNotesChange={onNotesChange}
        enabled={allowNotes}
      />

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
