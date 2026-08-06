import { create } from 'zustand';
import { emit } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  authClient,
  beginBrowserLogin as serviceBeginBrowserLogin,
  cancelBrowserLogin as serviceCancelBrowserLogin,
  submitManualCode as serviceSubmitManualCode,
} from '../features/auth';
import { ARCANE_WEB_URL } from '../config/api';

export type LoginStatus = 'idle' | 'waiting-browser' | 'exchanging' | 'error';

interface AuthState {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  /** Spendable credit balance (plan + top-up), in user-facing credits. */
  credits: number | null;
  token: string | null;
  loginStatus: LoginStatus;
  error: string | null;

  /** Open the website auth page in the browser; completes via deep link,
   * manual code paste, or the 10-minute timeout. */
  beginBrowserLogin: () => Promise<void>;
  cancelBrowserLogin: () => void;
  /** Manual-paste fallback — same grant code + exchange endpoint, NOT device flow. */
  submitManualCode: (code: string) => void;
  logout: () => Promise<void>;
  loadFromDisk: () => Promise<void>;
  /** Pull plan + credit balance from /v1/usage (best-effort). */
  refreshUsage: () => Promise<void>;
  /** Open the website billing/account page in the default browser — billing is
   * managed on the website (Cursor-style), not in the app. */
  openBilling: () => Promise<void>;
}

function isJwtExpired(token: string): boolean {
  const parts = token.split('.');
  if (parts.length < 2) return false;
  try {
    const payload = parts[1]
      .replace(/-/g, '+')
      .replace(/_/g, '/');
    const padded = payload + '='.repeat((4 - (payload.length % 4)) % 4);
    const decoded = atob(padded);
    const data = JSON.parse(decoded) as { exp?: number };
    if (typeof data.exp !== 'number') return false;
    // 30s skew to avoid edge-expiry requests.
    return Date.now() >= data.exp * 1000 - 30_000;
  } catch {
    return false;
  }
}

export const useAuthStore = create<AuthState>((set) => ({
  loggedIn: false,
  email: null,
  plan: null,
  credits: null,
  token: null,
  loginStatus: 'idle',
  error: null,

  beginBrowserLogin: async () => {
    set({ loginStatus: 'waiting-browser', error: null });
    try {
      await serviceBeginBrowserLogin({
        // Runs AFTER the service consumed the pending attempt (replay guard);
        // this handler owns the exchange + resulting UI state.
        onCode: async (code, verifier) => {
          set({ loginStatus: 'exchanging' });
          const result = await authClient.exchangeEditorCode(code, verifier);
          if (result.success && result.user) {
            // exchangeEditorCode saved the token to disk; read it back for
            // in-memory API clients (arcane-stream etc. read store.token).
            const stored = await authClient.loadFromDisk().catch(() => null);
            set({
              loggedIn: true,
              email: result.user.email,
              // The exchange response DOES carry plan + credits (the server's
              // makeUserResponse); populate them straight away so the account
              // view never flashes "—" while a /v1/usage round-trip lands.
              plan: result.user.plan,
              credits: result.user.credits,
              token: stored?.token ?? null,
              loginStatus: 'idle',
              error: null,
            });
            void emit('auth-changed');
            // Still refresh: /v1/usage additionally carries planPeriodEnd and
            // the per-bucket split, which the exchange response does not.
            void useAuthStore.getState().refreshUsage();
          } else {
            set({ loginStatus: 'error', error: result.error ?? 'Sign-in failed' });
          }
        },
        onError: (message) => set({ loginStatus: 'error', error: message }),
      });
    } catch (err) {
      // openUrl (or scheme lookup) rejected — e.g. the OS couldn't launch a
      // browser. The service already registered its deep-link listener/timer
      // before this could throw, so tear that down explicitly instead of
      // leaving the user stuck on 'waiting-browser' with a dangling listener.
      serviceCancelBrowserLogin();
      set({
        loginStatus: 'error',
        error: err instanceof Error ? err.message : 'Could not open the browser',
      });
    }
  },

  cancelBrowserLogin: () => {
    serviceCancelBrowserLogin();
    set({ loginStatus: 'idle', error: null });
  },

  submitManualCode: (code: string) => {
    // On success the onCode handler registered by beginBrowserLogin drives
    // 'exchanging' → success/error, exactly like the deep-link path.
    if (!serviceSubmitManualCode(code)) {
      set({
        loginStatus: 'error',
        error: 'No sign-in attempt in progress — click "Continue in browser" first.',
      });
    }
  },

  logout: async () => {
    serviceCancelBrowserLogin();
    await authClient.logout();
    set({ loggedIn: false, email: null, plan: null, credits: null, token: null, loginStatus: 'idle', error: null });
    void emit('auth-changed');
  },

  loadFromDisk: async () => {
    let stored: { token: string; email: string } | null;
    try {
      stored = await authClient.loadFromDisk();
    } catch (err) {
      // authClient.loadFromDisk REJECTS only on a genuine read/parse error
      // (missing file resolves null, see auth-client.ts) — a transient disk
      // hiccup, not a real logout. Leave whatever session state is already
      // in memory alone; resetting here is the regression this guards
      // against (a live session getting wiped by a one-off read error).
      console.warn('[auth] loadFromDisk: transient token-read error, keeping current session', err);
      return;
    }

    if (!stored) {
      // Token file missing — e.g. logout happened in ANOTHER window (spec C3)
      // or a fresh install. Reset instead of silently keeping stale state.
      set({ loggedIn: false, email: null, plan: null, credits: null, token: null, error: null });
      return;
    }

    if (isJwtExpired(stored.token)) {
      await authClient.logout().catch(() => {});
      set({ loggedIn: false, email: null, plan: null, credits: null, token: null, error: null });
      return;
    }

    // A valid token landed here while THIS window may have had its own
    // browser-login attempt in flight (cross-window login completed
    // elsewhere — spec C5/multi-window). Tear that attempt down so its
    // listener/10-min timer doesn't fire a spurious "timed out" error later
    // against a window that's already signed in. No-op if nothing pending.
    serviceCancelBrowserLogin();
    set({
      loggedIn: true,
      email: stored.email,
      token: stored.token,
      loginStatus: 'idle',
      error: null,
    });
    void useAuthStore.getState().refreshUsage();
  },

  refreshUsage: async () => {
    const token = useAuthStore.getState().token;
    if (!token) return;
    try {
      const u = await authClient.fetchUsage(token);
      set({ plan: u.plan, credits: u.credits.balance });
    } catch {
      // Best-effort — a transient failure must not clear a known balance.
    }
  },

  openBilling: async () => {
    await openUrl(`${ARCANE_WEB_URL}/account`).catch(() => {});
  },
}));
