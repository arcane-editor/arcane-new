import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { useUiStore } from '../../../stores/ui';

interface MaximizedAiOverlayProps {
  children: ReactNode;
}

function MaximizedAiOverlay({ children }: MaximizedAiOverlayProps) {
  const setAiPanelMaximized = useUiStore((s) => s.setAiPanelMaximized);
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    setMounted(true);
    return () => setMounted(false);
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        setAiPanelMaximized(false);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [setAiPanelMaximized]);

  const overlay = (
    <div className="ai-panel-overlay-root" data-mounted={mounted ? 'yes' : 'no'}>
      <div className="ai-panel-overlay-backdrop" />
      <div className="ai-panel-overlay-column">{children}</div>
    </div>
  );

  return createPortal(overlay, document.body);
}

export default MaximizedAiOverlay;
