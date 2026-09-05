import { useEffect } from 'react';
import { ShieldAlert } from 'lucide-react';
import { openUrl } from '@tauri-apps/plugin-opener';
import type { DotnetBlock } from '../../lsp';

interface DotnetMissingModalProps {
  /** Which prerequisite is missing, and the sentence describing it. */
  block: DotnetBlock;
  onClose: () => void;
}

const DOTNET_DOWNLOAD_URL = 'https://dotnet.microsoft.com/download';

/**
 * Titles differ per reason because the fix differs. Telling someone whose
 * .NET is merely too old to "install the .NET SDK" invites them to install
 * the same version again and see the same modal.
 */
const TITLES: Record<DotnetBlock['reason'], string> = {
  missing: '.NET SDK required',
  'sdk-missing': '.NET SDK required',
  'runtime-too-old': 'A newer .NET is required',
};

function DotnetMissingModal({ block, onClose }: DotnetMissingModalProps) {
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
          {TITLES[block.reason]}
        </h2>
        <p className="app-modal-body">
          {block.detail} Install it once and reopen the workspace — the editor
          sets up the C# language server itself from there.
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
