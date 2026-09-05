import { useCallback, useEffect, useRef } from 'react';
import { ArrowUp, ImagePlus, Square } from 'lucide-react';
import type { ImageAttachment } from '../../ai-panel';
import { DesignAttachments } from './DesignAttachments';

interface Props {
  value: string;
  onChange: (value: string) => void;
  onSubmit: () => void;
  onStop: () => void;
  running: boolean;
  /** Set when sending is impossible right now. */
  blockedReason: string | null;
  placeholder: string;
  images: ImageAttachment[];
  onRemoveImage: (id: string) => void;
  onPickImages: () => void;
  /** Stage images found on a paste. Returns true when it took some. */
  onPasteImages: (blobs: Blob[]) => boolean;
}

/**
 * The composer: an inset well at the foot of the dock.
 *
 * Raised onto its own surface rather than sitting flat as a third band, because
 * the panel needs exactly one place that says "this is where you act" — the log
 * above it is a record, and a record and an input drawn on the same ground read
 * as one undifferentiated column. It is also what gives a staged reference
 * image somewhere to live that is visibly part of the message you are about to
 * send.
 *
 * A real `<textarea>`, not the AI panel's Lexical composer. Two reasons, and
 * the second is the load-bearing one:
 *
 * 1. The panel's composer carries @-mentions and slash commands. Neither means
 *    anything here — the context is the one document on the canvas — and each
 *    is another surface to keep working.
 * 2. `usePreviewCamera` claims bare `+`, `-`, `0`, `1` and Space on `window`
 *    and lets them through only for `input, textarea, select,
 *    [contenteditable="true"]`. A textarea is covered by that selector
 *    structurally; a contenteditable is covered only as long as it renders
 *    that exact attribute. Typing "0" and watching the canvas jump to 100%
 *    would be a real bug, and this is the version that cannot have it.
 */
export function DesignComposer({
  value,
  onChange,
  onSubmit,
  onStop,
  running,
  blockedReason,
  placeholder,
  images,
  onRemoveImage,
  onPickImages,
  onPasteImages,
}: Props) {
  const ref = useRef<HTMLTextAreaElement>(null);

  // Grow with the content, up to a few lines. Measured from `scrollHeight`
  // after a reset, which is the only way to let it SHRINK again too.
  useEffect(() => {
    const node = ref.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, 120)}px`;
  }, [value]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      // Enter sends, Shift+Enter breaks the line. Deliberately NOT stopping
      // propagation on anything else: React listens below the document, so a
      // blanket stopPropagation here would kill every app hotkey while this
      // field has focus (see editor/CLAUDE.md).
      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
        e.preventDefault();
        onSubmit();
      }
    },
    [onSubmit],
  );

  const handlePaste = useCallback(
    (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
      // Only swallow the paste when it actually carried an image — a paste that
      // is text and a screenshot at once should still deliver the text.
      const blobs = Array.from(e.clipboardData?.items ?? [])
        .filter((i) => i.kind === 'file' && i.type.startsWith('image/'))
        .map((i) => i.getAsFile())
        .filter((f): f is File => f !== null);
      if (blobs.length === 0) return;
      if (onPasteImages(blobs)) e.preventDefault();
    },
    [onPasteImages],
  );

  const canSend = (value.trim().length > 0 || images.length > 0) && !running && !blockedReason;

  return (
    <div className="design-dock-composer">
      <DesignAttachments images={images} onRemove={onRemoveImage} />

      <textarea
        ref={ref}
        className="design-dock-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={handleKeyDown}
        onPaste={handlePaste}
        placeholder={placeholder}
        rows={1}
        spellCheck={false}
        aria-label="Describe the screen"
      />

      <div className="design-dock-tools">
        <button
          type="button"
          className="design-dock-tool"
          onClick={onPickImages}
          disabled={running}
          title="Attach a reference image — you can also paste one, or drop one on this panel"
          aria-label="Attach a reference image"
        >
          <ImagePlus size={13} strokeWidth={1.9} />
        </button>
        <span className="design-dock-tools-gap" />
        {running ? (
          <button type="button" className="design-dock-send" onClick={onStop} aria-label="Stop">
            <Square size={10} strokeWidth={2.5} fill="currentColor" />
          </button>
        ) : (
          <button
            type="button"
            className="design-dock-send"
            onClick={onSubmit}
            disabled={!canSend}
            aria-label="Send"
          >
            <ArrowUp size={13} strokeWidth={2.5} />
          </button>
        )}
      </div>
    </div>
  );
}

export default DesignComposer;
