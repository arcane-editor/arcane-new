import { LogIn, Sparkles } from 'lucide-react';
import { useUiStore } from '../../../stores/ui';
import { ACCOUNT_SECTION } from '../../settings';

function AiSignInGate() {
  const setAiPanelMaximized = useUiStore((s) => s.setAiPanelMaximized);
  const openSettings = useUiStore((s) => s.openSettings);

  function openAccount() {
    // Collapse the maximized overlay (if any) so the modal isn't competing
    // with a full-window panel for the foreground.
    setAiPanelMaximized(false);
    openSettings(ACCOUNT_SECTION);
  }

  return (
    <div className="ai-panel">
      <div className="ai-panel-header">
        <div className="ai-panel-header-title">
          <Sparkles size={14} />
          <span>AI Assistant</span>
        </div>
      </div>

      <div style={containerStyle}>
        <div style={cardStyle}>
          <div style={wordmarkStyle}>ARCANE</div>
          <div style={titleStyle}>Sign in to use AI</div>
          <div style={subtitleStyle}>
            Connect your account to chat, edit code, and run agents in this workspace.
          </div>
          <button onClick={openAccount} style={primaryBtnStyle}>
            <LogIn size={14} />
            Sign In
          </button>
          <button onClick={openAccount} style={secondaryBtnStyle}>
            Create account
          </button>
        </div>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  flex: 1,
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: '24px',
  overflow: 'auto',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 280,
  display: 'flex',
  flexDirection: 'column',
  alignItems: 'stretch',
  gap: 12,
  textAlign: 'center',
};

const wordmarkStyle: React.CSSProperties = {
  fontFamily: 'var(--font-display)',
  fontSize: 12,
  fontWeight: 600,
  letterSpacing: '2px',
  color: 'var(--text-secondary)',
  marginBottom: 12,
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text-primary)',
  marginBottom: 2,
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
  marginBottom: 8,
};

const primaryBtnStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  padding: '8px 14px',
  background: 'var(--button-primary-bg)',
  border: 'none',
  borderRadius: 6,
  color: 'var(--button-primary-text)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
};

const secondaryBtnStyle: React.CSSProperties = {
  padding: '6px 14px',
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--text-primary)',
  fontSize: 12,
  fontWeight: 500,
  cursor: 'pointer',
};

export default AiSignInGate;
