import { useEffect } from 'react';
import { FileStack } from 'lucide-react';

interface MetaChoiceDialogProps {
  /** How many assets in this drop have a sibling `.meta`. */
  count: number;
  onChoose: (includeMeta: boolean) => void;
  onCancel: () => void;
}

/**
 * Asked once per drop when files landing in a Unity project have sibling
 * `.meta` files.
 *
 * There is no safe default here, which is why it is a question. A `.meta`
 * carries a GUID unique to its origin project:
 *
 *  - from a *different* project, copying it duplicates that GUID, and Unity
 *    resolves the collision by reassigning one at random — silently breaking
 *    every scene and prefab reference to whichever asset loses.
 *  - from another checkout of the *same* project, the `.meta` must come along
 *    or the asset is imported fresh with a new GUID and existing references
 *    dangle.
 *
 * Only the user knows where the drop came from. Skip is the default because it
 * is recoverable — Unity mints a new `.meta` on refresh — whereas a duplicated
 * GUID corrupts references in a way that is tedious to find and undo.
 */
export function MetaChoiceDialog({ count, onChoose, onCancel }: MetaChoiceDialogProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter') onChoose(false);
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onChoose, onCancel]);

  const noun = count === 1 ? 'file has a .meta' : `files have .meta`;

  return (
    <div className="app-modal-root" onMouseDown={onCancel}>
      <div
        className="app-modal-card"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="app-modal-icon">
          <FileStack size={28} style={{ color: 'var(--warning)' }} />
        </div>
        <div className="app-modal-title">Bring .meta files along?</div>
        <div className="app-modal-body">
          {count} dropped {noun} alongside {count === 1 ? 'it' : 'them'}.
          <br />
          <br />
          A <code>.meta</code> holds a GUID unique to the project it came from. Copy it from{' '}
          <strong>another checkout of this same project</strong> and references keep resolving.
          Copy it from a <strong>different project</strong> and the GUID collides — Unity
          reassigns one at random and scene/prefab references break.
          <br />
          <br />
          Skipping is the safe choice: Unity generates a fresh <code>.meta</code> on the next
          refresh.
        </div>
        <div className="app-modal-actions">
          <button className="app-modal-secondary" onClick={() => onChoose(true)}>
            Copy .meta files
          </button>
          <button className="app-modal-primary" autoFocus onClick={() => onChoose(false)}>
            Skip .meta files
          </button>
        </div>
      </div>
    </div>
  );
}

export default MetaChoiceDialog;
