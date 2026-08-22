import { useEffect, useState } from 'react';
import { CreditCard, Globe, KeyRound, Loader2, LogOut, RotateCw, X } from 'lucide-react';
import { useAuthStore } from '../../../stores/auth';
import { reopenBrowser } from '../../auth';
import { usagePercent } from '../../../utils/usage-percent';

/**
 * Account pane of the settings modal — signed-in details, or the sign-in flow.
 *
 * Replaces the former `auth://account` editor tab. Same store and the same
 * browser-login service; only the surface changed, from a tab that displaced
 * the editor to a pane inside the modal.
 */
export function AccountSection() {
  const {
    loggedIn,
    email,
    plan,
    usage,
    planGrant,
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

  // NEVER a raw credit count here (owner directive) — a PERCENTAGE of the
  // plan's monthly grant only. `null` (grant unknown, or the fetch hasn't
  // landed) renders as "—", same as the old raw-credits placeholder did.
  const usedPct = usage && planGrant !== null ? usagePercent(planGrant, usage.planBalance) : null;

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
      <div className="settings-section">
        <h2 className="settings-section-title">Account</h2>

        <div className="settings-account-grid">
          <div className="settings-account-field">
            <div className="settings-account-field-label">Email</div>
            <div className="settings-account-field-value">{email}</div>
          </div>
          <div className="settings-account-field">
            <div className="settings-account-field-label">Plan</div>
            <div className="settings-account-field-value settings-account-plan">
              {plan ?? 'Free'}
            </div>
          </div>
          <div className="settings-account-field">
            <div className="settings-account-field-label">Usage</div>
            <div className="settings-account-field-value settings-account-credits">
              {usedPct === null
                ? '—'
                : plan === 'free'
                  ? `AI trial ${usedPct}% used`
                  : `${usedPct}% of monthly AI usage used`}
            </div>
            {usage && usage.topupBalance > 0 && (
              <div className="settings-account-usage-note">Extra usage available</div>
            )}
          </div>
        </div>

        <div className="settings-account-actions">
          <button className="settings-btn settings-btn-primary" onClick={() => void openBilling()}>
            <CreditCard size={14} />
            Manage plan &amp; credits
          </button>
          <button className="settings-btn settings-btn-danger" onClick={() => void logout()}>
            <LogOut size={14} />
            Sign Out
          </button>
        </div>

        <button
          className="settings-btn-link"
          onClick={() => {
            void (async () => {
              await logout();
              startBrowserLogin();
            })();
          }}
        >
          Switch account…
        </button>
      </div>
    );
  }

  return (
    <div className="settings-section">
      <h2 className="settings-section-title">Sign In</h2>
      <p className="settings-section-subtitle">
        Sign in to access AI features and sync settings
      </p>

      {error && <div className="settings-account-error">{error}</div>}

      {(loginStatus === 'idle' || loginStatus === 'error') && (
        <button className="settings-btn settings-btn-primary" onClick={startBrowserLogin}>
          <Globe size={14} />
          Continue in browser
        </button>
      )}

      {loginStatus === 'waiting-browser' && (
        <div className="settings-account-actions">
          <div className="settings-account-spinner">
            <Loader2 size={12} className="animate-spin" />
            Complete sign-in in your browser…
          </div>
          <button
            className="settings-btn settings-btn-secondary"
            onClick={() => void reopenBrowser()}
          >
            <RotateCw size={14} />
            Open browser again
          </button>
          <button className="settings-btn settings-btn-secondary" onClick={cancelBrowserLogin}>
            <X size={14} />
            Cancel
          </button>
          <button className="settings-btn-link" onClick={() => setShowPaste((v) => !v)}>
            <KeyRound size={12} />
            Browser didn&apos;t open? Paste the code
          </button>
          {showPaste && (
            <>
              <input
                type="text"
                className="settings-account-input"
                value={pasteCode}
                onChange={(e) => setPasteCode(e.target.value)}
                placeholder="Code from the success page"
                autoComplete="off"
                autoCorrect="off"
                autoCapitalize="off"
                spellCheck={false}
              />
              <button
                className="settings-btn settings-btn-primary"
                disabled={!pasteCode.trim()}
                onClick={() => {
                  submitManualCode(pasteCode);
                  setPasteCode('');
                }}
              >
                Submit code
              </button>
            </>
          )}
        </div>
      )}

      {loginStatus === 'exchanging' && (
        <div className="settings-account-spinner">
          <Loader2 size={12} className="animate-spin" />
          Signing you in…
        </div>
      )}
    </div>
  );
}

export default AccountSection;
