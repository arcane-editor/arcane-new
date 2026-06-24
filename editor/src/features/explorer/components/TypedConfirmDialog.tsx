import { useEffect, useState } from 'react';
import { ShieldAlert } from 'lucide-react';

interface TypedConfirmDialogProps {
  title: string;
  /** Body explaining the consequence. */
  message: string;
  /** The exact string the user must type to enable the confirm button. */
  confirmText: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * A destructive-action dialog that requires the user to type an exact string
 * (e.g. the file name) before the confirm button enables. Used for actions that
 * can silently destroy data — currently deleting a lone `.meta` file, which
 * orphans an asset's Unity import settings + GUID (F-6.1).
 */
export function TypedConfirmDialog({
  title,
  message,
  confirmText,
  confirmLabel = 'Delete',
  onConfirm,
  onCancel,
}: TypedConfirmDialogProps) {
  const [value, setValue] = useState('');
  const matches = value === confirmText;

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onCancel();
      if (e.key === 'Enter' && value === confirmText) onConfirm();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [value, confirmText, onConfirm, onCancel]);

  return (
    <div className="app-modal-root" onMouseDown={onCancel}>
      <div
        className="app-modal-card"
        role="dialog"
        aria-modal="true"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="app-modal-icon">
          <ShieldAlert size={28} style={{ color: 'var(--warning)' }} />
        </div>
        <div className="app-modal-title">{title}</div>
        <div className="app-modal-body">{message}</div>
        <input
          className="app-modal-input"
          autoFocus
          value={value}
          placeholder={confirmText}
          spellCheck={false}
          onChange={(e) => setValue(e.target.value)}
          style={{
            width: '100%',
            margin: '12px 0',
            padding: '6px 8px',
            background: 'var(--bg-input, var(--bg-sidebar))',
            border: '1px solid var(--border)',
            borderRadius: 4,
            color: 'var(--text-primary)',
            fontFamily: 'inherit',
            fontSize: 13,
          }}
        />
        <div className="app-modal-actions">
          <button className="app-modal-secondary" onClick={onCancel}>
            Cancel
          </button>
          <button
            className="app-modal-primary"
            disabled={!matches}
            onClick={onConfirm}
            style={{ opacity: matches ? 1 : 0.5, cursor: matches ? 'pointer' : 'not-allowed' }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

export default TypedConfirmDialog;
