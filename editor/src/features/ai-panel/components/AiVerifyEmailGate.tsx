import { useState } from 'react';
import { Loader2, MailCheck, Sparkles } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth';
import { useAiStore } from '../../../stores/ai';
import { authClient } from '../../auth';

/**
 * Shown when the server rejected an AI call with 403 `email_unverified`.
 *
 * The session is VALID here — this panel must never offer or trigger a sign
 * out. That conflation is exactly what trapped new signups in a loop before
 * arcane-stream learned to tell 401 from 403.
 */
function AiVerifyEmailGate() {
  const email = useAuthStore((s) => s.email);
  const token = useAuthStore((s) => s.token);
  const setVerificationRequired = useAiStore((s) => s.setVerificationRequired);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const resend = async () => {
    if (!token || busy) return;
    setBusy(true);
    setNotice(null);
    try {
      await authClient.resendVerification(token);
      setNotice(`Sent. Check ${email ?? 'your inbox'} for the link.`);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Could not resend the email.');
    } finally {
      setBusy(false);
    }
  };

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
          <MailCheck size={20} style={{ color: 'var(--accent)', alignSelf: 'center' }} />
          <div style={titleStyle}>Verify your email</div>
          <div style={subtitleStyle}>
            We sent a link to <strong>{email ?? 'your address'}</strong>. Click it to unlock AI
            features — you'll stay signed in here.
          </div>
          {notice && <div style={noticeStyle}>{notice}</div>}
          <button onClick={() => void resend()} disabled={busy} style={primaryBtnStyle}>
            {busy && <Loader2 size={14} className="animate-spin" />}
            {busy ? 'Sending…' : 'Resend verification email'}
          </button>
          <button onClick={() => setVerificationRequired(false)} style={secondaryBtnStyle}>
            I've verified — retry
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
  gap: 10,
  textAlign: 'center',
};

const titleStyle: React.CSSProperties = {
  fontSize: 15,
  fontWeight: 600,
  color: 'var(--text-primary)',
};

const subtitleStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  lineHeight: 1.5,
};

const noticeStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  padding: '6px 10px',
  background: 'var(--bg-input)',
  borderRadius: 4,
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

export default AiVerifyEmailGate;
