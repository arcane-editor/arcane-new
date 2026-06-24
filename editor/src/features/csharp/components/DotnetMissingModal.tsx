import { useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';

interface DotnetMissingModalProps {
  onClose: () => void;
}

const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download';

function DotnetMissingModal({ onClose }: DotnetMissingModalProps) {
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') onClose();
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  function handleDownload() {
    void openUrl(DOTNET_DOWNLOAD_URL);
  }

  return (
    <div className="app-modal-root" onMouseDown={onClose}>
      <div
        className="app-modal-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="dotnet-missing-title"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="app-modal-icon">
          <ShieldAlert size={22} />
        </div>
        <h2 id="dotnet-missing-title" className="app-modal-title">
          .NET SDK required
        </h2>
        <p className="app-modal-body">
          This Unity project needs the .NET SDK for C# IntelliSense, diagnostics,
          and code navigation. Install it once and reopen the workspace — the
          editor will pick it up automatically.
        </p>
        <div className="app-modal-actions">
          <button
            type="button"
            className="app-modal-primary"
            onClick={handleDownload}
            autoFocus
          >
            Download .NET SDK
          </button>
          <button
            type="button"
            className="app-modal-secondary"
            onClick={onClose}
          >
            Continue without C#
          </button>
        </div>
      </div>
    </div>
  );
}

export default DotnetMissingModal;
