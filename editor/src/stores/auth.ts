import { create } from 'zustand';
import { emit } from '@tauri-apps/api/event';
import {
  authClient,
  beginBrowserLogin as serviceBeginBrowserLogin,
  cancelBrowserLogin as serviceCancelBrowserLogin,
  submitManualCode as serviceSubmitManualCode,
} from '../features/auth';

export type LoginStatus = 'idle' | 'waiting-browser' | 'exchanging' | 'error';

interface AuthState {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
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
              // The exchange response carries no plan (contract:
              // {id, email, role, emailVerified}); /me can hydrate it later.
              plan: null,
              token: stored?.token ?? null,
              loginStatus: 'idle',
              error: null,
            });
            void emit('auth-changed');
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
    set({ loggedIn: false, email: null, plan: null, token: null, loginStatus: 'idle', error: null });
    void emit('auth-changed');
  },

  loadFromDisk: async () => {
    const stored = await authClient.loadFromDisk();
    if (!stored) {
      // Token file missing — e.g. logout happened in ANOTHER window (spec C3)
      // or a fresh install. Reset instead of silently keeping stale state.
      set({ loggedIn: false, email: null, plan: null, token: null, error: null });
      return;
    }

    if (isJwtExpired(stored.token)) {
      await authClient.logout().catch(() => {});
      set({ loggedIn: false, email: null, plan: null, token: null, error: null });
      return;
    }

    set({
      loggedIn: true,
      email: stored.email,
      token: stored.token,
    });
  },
}));
