import { useEffect, useState } from 'react';
import { CreditCard, Globe, KeyRound, Loader2, LogOut, RotateCw, X } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth';
import { reopenBrowser } from '../services/browser-login';

function AuthTab() {
  const {
    loggedIn,
    email,
    plan,
    credits,
    loginStatus,
    error,
    beginBrowserLogin,
    cancelBrowserLogin,
    submitManualCode,
    logout,
    refreshUsage,
    openBilling,
  } = useAuthStore();
  const [showPaste, setShowPaste] = useState(false);
  const [pasteCode, setPasteCode] = useState('');

  // Pull the latest plan + credit balance whenever the account view is shown
  // signed-in (also refreshed after login and on 402 from the AI stream).
  useEffect(() => {
    if (loggedIn) void refreshUsage();
  }, [loggedIn, refreshUsage]);

  const startBrowserLogin = () => {
    setShowPaste(false);
    setPasteCode('');
    void beginBrowserLogin();
  };

  if (loggedIn) {
    return (
      <div style={containerStyle}>
        <div style={cardStyle}>
          <h2 style={{ margin: '0 0 16px', fontSize: 18, fontWeight: 600 }}>Account</h2>
          <div style={{ marginBottom: 12 }}>
            <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>Email</div>
            <div style={{ fontSize: 14 }}>{email}</div>
          </div>
          <div style={{ display: 'flex', gap: 12, marginBottom: 16 }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>Plan</div>
              <div style={{ fontSize: 14, textTransform: 'capitalize' }}>{plan ?? 'Free'}</div>
            </div>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>Credits left</div>
              <div style={{ fontSize: 14, fontFamily: 'var(--font-mono)' }}>
                {credits === null ? '—' : Math.round(credits).toLocaleString()}
              </div>
            </div>
          </div>
          <button
            onClick={() => void openBilling()}
            style={{ ...primaryBtnStyle, marginBottom: 8 }}
          >
            <CreditCard size={14} />
            Manage plan &amp; credits
          </button>
          <button onClick={() => void logout()} style={dangerBtnStyle}>
            <LogOut size={14} />
            Sign Out
          </button>
          <button
            onClick={() => {
              void (async () => {
                await logout();
                startBrowserLogin();
              })();
            }}
            style={{ ...linkBtnStyle, marginTop: 12, display: 'block' }}
          >
            Switch account…
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>
          Sign In
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-secondary)' }}>
          Sign in to access AI features and sync settings
        </p>

        {error && (
          <div
            style={{
              padding: '8px 12px',
              marginBottom: 12,
              background: 'var(--error-bg)',
              border: '1px solid var(--error-border)',
              borderRadius: 4,
              fontSize: 12,
              color: 'var(--error-text)',
            }}
          >
            {error}
          </div>
        )}

          <div>
            {(loginStatus === 'idle' || loginStatus === 'error') && (
              <button onClick={startBrowserLogin} style={primaryBtnStyle}>
                <Globe size={14} />
                Continue in browser
              </button>
            )}

            {loginStatus === 'waiting-browser' && (
              <div>
                <div style={spinnerRowStyle}>
                  <Loader2 size={12} className="animate-spin" />
                  Complete sign-in in your browser…
                </div>
                <button onClick={() => void reopenBrowser()} style={secondaryBtnStyle}>
                  <RotateCw size={14} />
                  Open browser again
                </button>
                <button
                  onClick={cancelBrowserLogin}
                  style={{ ...secondaryBtnStyle, marginTop: 8 }}
                >
                  <X size={14} />
                  Cancel
                </button>
                <button
                  onClick={() => setShowPaste((v) => !v)}
                  style={{ ...linkBtnStyle, marginTop: 12, display: 'block' }}
                >
                  <KeyRound size={12} style={{ verticalAlign: 'text-bottom', marginRight: 4 }} />
                  Browser didn't open? Paste the code
                </button>
                {showPaste && (
                  <div style={{ marginTop: 8 }}>
                    <input
                      type="text"
                      value={pasteCode}
                      onChange={(e) => setPasteCode(e.target.value)}
                      placeholder="Code from the success page"
                      style={{ ...inputStyle, marginBottom: 8 }}
                      autoComplete="off"
                      autoCorrect="off"
                      autoCapitalize="off"
                      spellCheck={false}
                    />
                    <button
                      disabled={!pasteCode.trim()}
                      onClick={() => {
                        submitManualCode(pasteCode);
                        setPasteCode('');
                      }}
                      style={primaryBtnStyle}
                    >
                      Submit code
                    </button>
                  </div>
                )}
              </div>
            )}

            {loginStatus === 'exchanging' && (
              <div style={spinnerRowStyle}>
                <Loader2 size={12} className="animate-spin" />
                Signing you in…
              </div>
            )}
          </div>
      </div>
    </div>
  );
}

const containerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'center',
  alignItems: 'flex-start',
  height: '100%',
  overflow: 'auto',
  padding: '48px 24px',
};

const cardStyle: React.CSSProperties = {
  width: '100%',
  maxWidth: 380,
  background: 'var(--bg-sidebar)',
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 24,
};

const inputStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 10px',
  background: 'var(--bg-input)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--text-primary)',
  fontSize: 13,
  outline: 'none',
  boxSizing: 'border-box',
};

const primaryBtnStyle: React.CSSProperties = {
  width: '100%',
  padding: '8px 16px',
  background: 'var(--button-primary-bg)',
  border: 'none',
  borderRadius: 4,
  color: 'var(--button-primary-text)',
  fontSize: 13,
  fontWeight: 600,
  cursor: 'pointer',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
};

const secondaryBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: 'var(--bg-input)',
  color: 'var(--text-primary)',
  border: '1px solid var(--border)',
  fontWeight: 500,
};

const dangerBtnStyle: React.CSSProperties = {
  ...primaryBtnStyle,
  background: 'var(--button-danger-bg)',
  color: 'var(--button-danger-text)',
};

const linkBtnStyle: React.CSSProperties = {
  background: 'none',
  border: 'none',
  color: 'var(--accent)',
  cursor: 'pointer',
  padding: 0,
  textDecoration: 'underline',
};

const spinnerRowStyle: React.CSSProperties = {
  fontSize: 12,
  color: 'var(--text-secondary)',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  gap: 6,
  marginBottom: 12,
};

export default AuthTab;
