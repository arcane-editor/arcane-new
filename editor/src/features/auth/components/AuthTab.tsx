import { useEffect, useRef, useState } from 'react';
import { CreditCard, Globe, KeyRound, Loader2, LogOut, RotateCw, Smartphone, X } from 'lucide-react';
import { emit } from '@tauri-apps/api/event';
import { useAuthStore } from '../../../stores/auth';
import { authClient } from '../services/auth-client';
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
  // Browser sign-in works on every platform: where the OS won't route the
  // custom scheme (macOS `tauri dev`), the loopback transport covers it.
  // Device code is a manual fallback, never a default.
  const [mode, setMode] = useState<'browser' | 'device'>('browser');
  const [showPaste, setShowPaste] = useState(false);
  const [pasteCode, setPasteCode] = useState('');

  // Device flow state (kept as fallback; endpoints unchanged)
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);
  // Ref (not local-var) so the unmount cleanup below can reach the SAME
  // interval the in-flight handleDeviceFlow call created — closing a tab
  // mid-poll used to leave this 5s interval running forever (it was only
  // ever cleared from inside itself, on authorized/expired/error).
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    return () => {
      if (pollIntervalRef.current !== null) {
        clearInterval(pollIntervalRef.current);
        pollIntervalRef.current = null;
      }
    };
  }, []);

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

  const handleDeviceFlow = async () => {
    // Guard against a double-click before `polling` flips (requestDeviceCode is
    // async): a second interval would orphan the first, whose cleanup then
    // clears the active poll — hanging "Waiting for authorization…".
    if (pollIntervalRef.current !== null || polling) return;
    try {
      const response = await authClient.requestDeviceCode();
      setDeviceCode(response.device_code);
      setUserCode(response.user_code);
      setVerificationUri(response.verification_uri);
      setPolling(true);

      // Poll for authorization
      pollIntervalRef.current = setInterval(async () => {
        try {
          const result = await authClient.pollDeviceToken(response.device_code);
          if (result.status === 'authorized') {
            clearInterval(pollIntervalRef.current!);
            pollIntervalRef.current = null;
            setPolling(false);
            setDeviceCode(null);
            // pollDeviceToken saved the token to disk — pull it into the
            // store (fixes the pre-existing "store token stays null until
            // restart" gap), then broadcast to the other windows.
            await useAuthStore.getState().loadFromDisk();
            if (result.user) {
              useAuthStore.setState({ plan: result.user.plan ?? null });
            }
            void emit('auth-changed');
          } else if (result.status === 'expired') {
            clearInterval(pollIntervalRef.current!);
            pollIntervalRef.current = null;
            setPolling(false);
            setDeviceCode(null);
            useAuthStore.setState({ error: 'Device code expired. Try again.' });
          }
        } catch {
          clearInterval(pollIntervalRef.current!);
          pollIntervalRef.current = null;
          setPolling(false);
        }
      }, 5000);
    } catch (err) {
      useAuthStore.setState({ error: err instanceof Error ? err.message : 'Device flow failed' });
    }
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
          {mode === 'browser' ? 'Sign In' : 'Device Sign In'}
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

        {mode === 'browser' ? (
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
        ) : (
          <div>
            {!deviceCode ? (
              <button onClick={handleDeviceFlow} disabled={polling} style={primaryBtnStyle}>
                <Smartphone size={14} />
                Generate Device Code
              </button>
            ) : (
              <div style={{ textAlign: 'center' }}>
                <div style={{ fontSize: 12, color: 'var(--text-secondary)', marginBottom: 8 }}>
                  Enter this code at:
                </div>
                <div style={{ fontSize: 12, color: 'var(--info)', marginBottom: 12 }}>
                  {verificationUri}
                </div>
                <div
                  style={{
                    fontSize: 24,
                    fontWeight: 700,
                    fontFamily: 'var(--font-mono)',
                    letterSpacing: 4,
                    padding: '12px 0',
                    background: 'var(--bg-input)',
                    borderRadius: 6,
                    marginBottom: 12,
                  }}
                >
                  {userCode}
                </div>
                {polling && (
                  <div style={spinnerRowStyle}>
                    <Loader2 size={12} className="animate-spin" />
                    Waiting for authorization...
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 12, fontSize: 12 }}>
          {mode === 'browser' && (
            <button
              onClick={() => {
                cancelBrowserLogin();
                setShowPaste(false);
                setMode('device');
              }}
              style={linkBtnStyle}
            >
              Use a device code instead
            </button>
          )}
          {mode === 'device' && (
            <button
              onClick={() => {
                useAuthStore.setState({ error: null });
                setMode('browser');
              }}
              style={linkBtnStyle}
            >
              Sign in with browser
            </button>
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
