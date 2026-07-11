import { useState } from 'react';
import { LogIn, UserPlus, LogOut, Loader2, Smartphone } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth';
import { authClient } from '../services/auth-client';

function AuthTab() {
  const { loggedIn, email, plan, loading, error, login, signup, logout } = useAuthStore();
  const [mode, setMode] = useState<'login' | 'signup' | 'device'>('login');
  const [formEmail, setFormEmail] = useState('');
  const [formPassword, setFormPassword] = useState('');
  const [formConfirmPassword, setFormConfirmPassword] = useState('');
  const [promoCode, setPromoCode] = useState('');

  // Device flow state
  const [deviceCode, setDeviceCode] = useState<string | null>(null);
  const [userCode, setUserCode] = useState<string | null>(null);
  const [verificationUri, setVerificationUri] = useState<string | null>(null);
  const [polling, setPolling] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (mode === 'login') {
      await login(formEmail, formPassword);
    } else if (mode === 'signup') {
      if (formPassword !== formConfirmPassword) {
        useAuthStore.setState({ error: 'Passwords do not match' });
        return;
      }
      await signup(formEmail, formPassword, promoCode || undefined);
    }
  };

  const handleDeviceFlow = async () => {
    try {
      const response = await authClient.requestDeviceCode();
      setDeviceCode(response.device_code);
      setUserCode(response.user_code);
      setVerificationUri(response.verification_uri);
      setPolling(true);

      // Poll for authorization
      const interval = setInterval(async () => {
        try {
          const result = await authClient.pollDeviceToken(response.device_code);
          if (result.status === 'authorized') {
            clearInterval(interval);
            setPolling(false);
            if (result.user) {
              useAuthStore.setState({
                loggedIn: true,
                email: result.user.email,
                plan: result.user.plan,
              });
            }
          } else if (result.status === 'expired') {
            clearInterval(interval);
            setPolling(false);
            setDeviceCode(null);
            useAuthStore.setState({ error: 'Device code expired. Try again.' });
          }
        } catch {
          clearInterval(interval);
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
          {plan && (
            <div style={{ marginBottom: 16 }}>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, marginBottom: 4 }}>Plan</div>
              <div style={{ fontSize: 14, textTransform: 'capitalize' }}>{plan}</div>
            </div>
          )}
          <button onClick={logout} style={dangerBtnStyle}>
            <LogOut size={14} />
            Sign Out
          </button>
        </div>
      </div>
    );
  }

  return (
    <div style={containerStyle}>
      <div style={cardStyle}>
        <h2 style={{ margin: '0 0 4px', fontSize: 18, fontWeight: 600 }}>
          {mode === 'login' ? 'Sign In' : mode === 'signup' ? 'Create Account' : 'Device Sign In'}
        </h2>
        <p style={{ margin: '0 0 16px', fontSize: 12, color: 'var(--text-secondary)' }}>
          Sign in to access AI features and sync settings
        </p>

        {error && (
          <div style={{
            padding: '8px 12px',
            marginBottom: 12,
            background: 'var(--error-bg)',
            border: '1px solid var(--error-border)',
            borderRadius: 4,
            fontSize: 12,
            color: 'var(--error-text)',
          }}>
            {error}
          </div>
        )}

        {mode !== 'device' ? (
          <form onSubmit={handleSubmit}>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Email</label>
              <input
                type="email"
                value={formEmail}
                onChange={(e) => setFormEmail(e.target.value)}
                required
                style={inputStyle}
                placeholder="you@example.com"
              />
            </div>
            <div style={{ marginBottom: 12 }}>
              <label style={labelStyle}>Password</label>
              <input
                type="password"
                value={formPassword}
                onChange={(e) => setFormPassword(e.target.value)}
                required
                style={inputStyle}
                placeholder="Password"
              />
            </div>
            {mode === 'signup' && (
              <>
                <div style={{ marginBottom: 12 }}>
                  <label style={labelStyle}>Confirm Password</label>
                  <input
                    type="password"
                    value={formConfirmPassword}
                    onChange={(e) => setFormConfirmPassword(e.target.value)}
                    required
                    style={inputStyle}
                    placeholder="Confirm password"
                  />
                </div>
                <div style={{ marginBottom: 12 }}>
                  <label style={labelStyle}>Promo Code (optional)</label>
                  <input
                    type="text"
                    value={promoCode}
                    onChange={(e) => setPromoCode(e.target.value)}
                    style={inputStyle}
                    placeholder="Enter promo code"
                    autoComplete="off" autoCorrect="off" autoCapitalize="off" spellCheck={false}
                  />
                </div>
              </>
            )}
            <button type="submit" disabled={loading} style={primaryBtnStyle}>
              {loading ? <Loader2 size={14} className="animate-spin" /> : mode === 'login' ? <LogIn size={14} /> : <UserPlus size={14} />}
              {mode === 'login' ? 'Sign In' : 'Create Account'}
            </button>
          </form>
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
                <div style={{
                  fontSize: 24,
                  fontWeight: 700,
                  fontFamily: 'var(--font-mono)',
                  letterSpacing: 4,
                  padding: '12px 0',
                  background: 'var(--bg-input)',
                  borderRadius: 6,
                  marginBottom: 12,
                }}>
                  {userCode}
                </div>
                {polling && (
                  <div style={{ fontSize: 12, color: 'var(--text-secondary)', display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6 }}>
                    <Loader2 size={12} className="animate-spin" />
                    Waiting for authorization...
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div style={{ marginTop: 16, display: 'flex', gap: 12, fontSize: 12 }}>
          {mode !== 'login' && (
            <button onClick={() => { setMode('login'); useAuthStore.setState({ error: null }); }} style={linkBtnStyle}>
              Sign In
            </button>
          )}
          {mode !== 'signup' && (
            <button onClick={() => { setMode('signup'); useAuthStore.setState({ error: null }); }} style={linkBtnStyle}>
              Create Account
            </button>
          )}
          {mode !== 'device' && (
            <button onClick={() => { setMode('device'); useAuthStore.setState({ error: null }); }} style={linkBtnStyle}>
              Device Sign In
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

const labelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 12,
  color: 'var(--text-secondary)',
  marginBottom: 4,
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

export default AuthTab;
