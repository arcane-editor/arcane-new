import { useEffect } from 'react';
import { Network } from 'lucide-react';

interface GraphifyIntroModalProps {
  onClose: () => void;
  onGenerate: () => void;
  onSuppress: () => void;
}

function GraphifyIntroModal({ onClose, onGenerate, onSuppress }: GraphifyIntroModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleGenerate() {
    onGenerate();
    onClose();
  }

  function handleSuppress() {
    onSuppress();
    onClose();
  }

  return (
    <div className="app-modal-root" onMouseDown={onClose}>
      <div
        className="app-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="graphify-intro-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="app-modal-icon">
          <Network size={22} />
        </div>
        <h2 id="graphify-intro-title" className="app-modal-title">
          Index this codebase for AI
        </h2>
        <p className="app-modal-body">
          Generate a structural map of the project so the AI assistant can navigate
          calls, imports, and dependencies quickly. This runs locally — no code
          leaves your machine.
        </p>
        <div className="app-modal-actions">
          <button
            type="button"
            className="app-modal-primary"
            onClick={handleGenerate}
            autoFocus
          >
            Generate graph
          </button>
          <button
            type="button"
            className="app-modal-secondary"
            onClick={onClose}
          >
            Skip for now
          </button>
        </div>
        <button
          type="button"
          className="app-modal-tertiary"
          onClick={handleSuppress}
        >
          Don't ask again for this project
        </button>
      </div>
    </div>
  );
}

export default GraphifyIntroModal;
