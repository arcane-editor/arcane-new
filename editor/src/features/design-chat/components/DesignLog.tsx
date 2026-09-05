import { useEffect, useRef, useState } from 'react';
import { Check, CircleAlert, ImageOff, Loader, MessageCircleQuestion, Shield } from 'lucide-react';
import type { DesignRow } from '../services/design-rows';
import type { DesignRender } from '../../../stores/design-chat';

interface Props {
  rows: DesignRow[];
  /** Rendered under the last row while a turn is live. */
  status: string | null;
  emptyHint: string;
  /**
   * The picture of the screen this turn produced, if there is one. Already
   * filtered to the session's document by the dock — a render of the tab you
   * just left is worse than none.
   */
  render: DesignRender | null;
  /** Answer a blocked `ask_user`. The turn stays open until this fires. */
  onAnswer: (toolCallId: string, answer: string) => void;
  /** Resolve a blocked approval. Same — the turn is waiting on it. */
  onPermission: (toolCallId: string, optionId: string) => void;
}

/**
 * The transcript, rendered as a log rather than as a chat.
 *
 * There are no bubbles, no avatars and no role labels, because the content is
 * not a conversation — it is a record of what happened to the document behind
 * this panel. A request, the direction the agent committed to, then the files
 * it wrote and the measurements it took, in the same monospaced metric style
 * the preview header already uses for `1200 × 675`. The counts sit in their own
 * right-aligned column, which is what lets the rows line up without a divider
 * between them.
 */
export function DesignLog({ rows, status, emptyHint, render, onAnswer, onPermission }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const pinned = useRef(true);

  // Follow the tail, but only while the reader is already at it — scrolling up
  // to re-read an earlier turn must not be yanked back on the next token.
  useEffect(() => {
    const node = ref.current;
    if (!node || !pinned.current) return;
    node.scrollTop = node.scrollHeight;
  }, [rows, status, render]);

  function handleScroll() {
    const node = ref.current;
    if (!node) return;
    pinned.current = node.scrollHeight - node.scrollTop - node.clientHeight < 24;
  }

  if (rows.length === 0 && !status) {
    return (
      <div className="design-log is-empty" ref={ref}>
        <p className="design-log-empty">{emptyHint}</p>
      </div>
    );
  }

  return (
    <div className="design-log" ref={ref} onScroll={handleScroll}>
      {rows.map((row) => (
        <Row key={row.id} row={row} onAnswer={onAnswer} onPermission={onPermission} />
      ))}
      {render && <RenderTile render={render} />}
      {status && (
        <p className="design-log-status" aria-live="polite">
          <Loader size={11} className="design-log-spin" strokeWidth={2} />
          {status}
        </p>
      )}
    </div>
  );
}

/**
 * What the screen looks like now.
 *
 * The log's other rows are counts and file names, which is the right register
 * for "what happened" and the wrong one for "does this look right". A picture
 * settles in half a second things no number in this panel can: that the title
 * collides with the panel edge, that the accent landed on the least important
 * control, that the whole screen came out grey.
 *
 * A failed capture is stated, not hidden. `renderToPng` returns null rather
 * than a blank frame for every failure, and rendering nothing here would let a
 * screen that could not be drawn read exactly like a screen with nothing on it.
 */
function RenderTile({ render }: { render: DesignRender }) {
  const [open, setOpen] = useState(false);

  if (!render.dataUrl) {
    return (
      <p className="design-log-render is-missing">
        <ImageOff size={11} strokeWidth={2} />
        The render could not be captured — the layout numbers above still hold.
      </p>
    );
  }

  return (
    <figure className={`design-log-render${open ? ' is-open' : ''}`}>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        title={open ? 'Smaller' : 'See it larger'}
        aria-expanded={open}
      >
        <img src={render.dataUrl} alt={`Rendered preview of ${render.documentPath}`} />
      </button>
    </figure>
  );
}

function Row({
  row,
  onAnswer,
  onPermission,
}: {
  row: DesignRow;
  onAnswer: (toolCallId: string, answer: string) => void;
  onPermission: (toolCallId: string, optionId: string) => void;
}) {
  switch (row.kind) {
    case 'request':
      return <p className="design-log-request">{row.text}</p>;

    case 'direction':
      // The one line the turn is accountable to. The design prompt requires the
      // model to open with it, so it is given the weight of a claim rather than
      // being buried as the first sentence of a paragraph.
      return <p className="design-log-direction">{row.text}</p>;

    case 'prose':
      return <p className="design-log-prose">{row.text}</p>;

    case 'action':
      return (
        <p className="design-log-action" data-status={row.status}>
          <span className="design-log-mark">
            {row.status === 'error' ? (
              <CircleAlert size={10} strokeWidth={2.5} />
            ) : row.status === 'complete' ? (
              <Check size={10} strokeWidth={3} />
            ) : (
              <Loader size={10} strokeWidth={2} className="design-log-spin" />
            )}
          </span>
          {row.verb && <span className="design-log-verb">{row.verb}</span>}
          <span className="design-log-subject">{row.subject}</span>
          {row.detail && <span className="design-log-detail">{row.detail}</span>}
        </p>
      );

    case 'verified': {
      // Says what was MEASURED, and says plainly when nothing was — an
      // unmeasured layout must never read as a clean one.
      const measured =
        row.elements === null
          ? 'layout not measured'
          : row.problems && row.problems > 0
            ? `${row.elements} elements · ${row.problems} geometry ${row.problems === 1 ? 'problem' : 'problems'}`
            : row.unstyled
              ? `${row.unstyled} of ${row.elements} elements unstyled`
              : `${row.elements} elements laid out`;
      return (
        <p className="design-log-verified" data-bad={row.problems || row.unstyled ? 'yes' : 'no'}>
          <span className="design-log-verb">verified</span>
          <span className="design-log-subject">{measured}</span>
          <span className="design-log-detail">
            {row.files} {row.files === 1 ? 'file' : 'files'}
          </span>
        </p>
      );
    }

    case 'question':
      // The turn is BLOCKED here until this is answered, so it is the loudest
      // thing in the log and it is answerable in place. Options are one click;
      // anything else is typed into the composer, which routes to the question
      // rather than starting a new message.
      return (
        <div className="design-log-ask" data-answered={row.answer || row.cancelled ? 'yes' : 'no'}>
          <p className="design-log-ask-question">
            <MessageCircleQuestion size={12} strokeWidth={2} />
            {row.question}
          </p>
          {row.answer ? (
            <p className="design-log-ask-answer">{row.answer}</p>
          ) : row.cancelled ? (
            <p className="design-log-ask-answer">Not answered — the turn ended first.</p>
          ) : (
            <>
              {row.options.length > 0 && (
                <div className="design-log-ask-options">
                  {row.options.map((option) => (
                    <button
                      key={option.label}
                      type="button"
                      className="design-log-ask-option"
                      title={option.description}
                      onClick={() => onAnswer(row.toolCallId, option.label)}
                    >
                      {option.label}
                    </button>
                  ))}
                </div>
              )}
              <p className="design-log-ask-hint">Or type an answer below.</p>
            </>
          )}
        </div>
      );

    case 'permission': {
      const chosen = row.options.find((o) => o.optionId === row.resolvedOptionId);
      return (
        <div className="design-log-ask" data-answered={chosen ? 'yes' : 'no'}>
          <p className="design-log-ask-question">
            <Shield size={12} strokeWidth={2} />
            Allow the agent to {row.detail}?
          </p>
          {chosen ? (
            <p className="design-log-ask-answer">{chosen.name}</p>
          ) : (
            <div className="design-log-ask-options">
              {row.options.map((option) => (
                <button
                  key={option.optionId}
                  type="button"
                  className="design-log-ask-option"
                  data-reject={option.kind.startsWith('reject') ? 'yes' : 'no'}
                  onClick={() => onPermission(row.toolCallId, option.optionId)}
                >
                  {option.name}
                </button>
              ))}
            </div>
          )}
        </div>
      );
    }

    case 'notice':
      return (
        <div className="design-log-notice" data-tone={row.tone}>
          <p className="design-log-notice-title">{row.text}</p>
          {row.detail && <p className="design-log-notice-detail">{row.detail}</p>}
          {row.raw && (
            // Collapsed by default, because the provider's own wording is
            // diagnostic rather than instructive — but it is the only thing
            // that names the real cause, so it has to be one click away.
            <details className="design-log-notice-raw">
              <summary>What the server said</summary>
              <pre>{row.raw}</pre>
            </details>
          )}
        </div>
      );
  }
}

export default DesignLog;
