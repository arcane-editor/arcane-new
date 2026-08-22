import { create } from 'zustand';
import { emit } from '@tauri-apps/api/event';
import { openUrl } from '@tauri-apps/plugin-opener';
import {
  authClient,
  beginBrowserLogin as serviceBeginBrowserLogin,
  cancelBrowserLogin as serviceCancelBrowserLogin,
  submitManualCode as serviceSubmitManualCode,
  resumeFromColdStart as serviceResumeFromColdStart,
  hadLaunchUrl as serviceHadLaunchUrl,
  planGrantsClient,
  type Session,
} from '../features/auth';
import { ARCANE_WEB_URL } from '../config/api';

export type LoginStatus = 'idle' | 'waiting-browser' | 'exchanging' | 'error';

interface AuthState {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  /** Spendable credit balance (plan + top-up), in user-facing credits. Never
   *  rendered raw anywhere user-facing — see `usage`/`planGrant` below, which
   *  exist so the UI can show a PERCENTAGE instead (owner directive). */
  credits: number | null;
  /**
   * Per-bucket split of `credits`, from `/v1/usage`'s `credits.plan` /
   * `credits.topup` (`refreshUsage`) — the plan-grant balance and the top-up
   * balance separately. `planBalance` is what `usagePercent` measures against
   * the monthly grant (`planGrant`); `topupBalance` only ever drives a
   * boolean "extra usage available" line, never a number.
   */
  usage: { planBalance: number; topupBalance: number } | null;
  /**
   * This account's plan's monthly credit grant — NOT carried by `/v1/usage`,
   * so it's fetched separately (`planGrantsClient`, `GET /v1/billing/plans`,
   * public + module-cached) and stamped alongside `usage`. `null` until that
   * fetch lands, or if it fails; `0` for a plan id outside the tier ladder.
   * See `utils/usage-percent.ts`'s `usagePercent` for how the two combine.
   */
  planGrant: number | null;
  token: string | null;
  loginStatus: LoginStatus;
  error: string | null;

  /** Open the website auth page in the browser; completes via deep link,
   * manual code paste, or the 10-minute timeout. */
  beginBrowserLogin: () => Promise<void>;
  cancelBrowserLogin: () => void;
  /** Manual-paste fallback — same grant code + exchange endpoint, NOT device flow. */
  submitManualCode: (code: string) => void;
  /** Startup hook: finish a cold-start deep link, or re-initiate when one
   * arrived with nothing to match it. */
  resumeColdStartLogin: () => Promise<void>;
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

/** Land an already-minted session (the POLL channel's win) in the store. No
 *  exchange to do — the server returned the token directly — so this only has
 *  to persist it and mirror what exchangeAndApply sets. */
async function applySession(
  set: (partial: Partial<AuthState>) => void,
  session: Session,
): Promise<void> {
  await authClient.saveToken(session.token, session.user.email);
  set({
    loggedIn: true,
    email: session.user.email,
    plan: session.user.plan,
    credits: session.user.credits,
    token: session.token,
    loginStatus: 'idle',
    error: null,
  });
  void emit('auth-changed');
  void useAuthStore.getState().refreshUsage();
}

/** Exchange a grant code and land the resulting session in the store. Shared
 *  by the in-app flow and the cold-start resume so the two can never drift. */
async function exchangeAndApply(
  set: (partial: Partial<AuthState>) => void,
  code: string,
  verifier: string,
): Promise<void> {
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
}

export const useAuthStore = create<AuthState>((set) => ({
  loggedIn: false,
  email: null,
  plan: null,
  credits: null,
  usage: null,
  planGrant: null,
  token: null,
  loginStatus: 'idle',
  error: null,

  beginBrowserLogin: async () => {
    set({ loginStatus: 'waiting-browser', error: null });
    try {
      await serviceBeginBrowserLogin({
        // Runs AFTER the service consumed the pending attempt (replay guard);
        // this handler owns the exchange + resulting UI state.
        onCode: (code, verifier) => exchangeAndApply(set, code, verifier),
        onSession: (session) => applySession(set, session),
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

  resumeColdStartLogin: async () => {
    const handlers = {
      onCode: (code: string, verifier: string) => exchangeAndApply(set, code, verifier),
      onSession: (session: Session) => applySession(set, session),
      onError: (message: string) => set({ loginStatus: 'error', error: message }),
    };
    try {
      // Case 1: this app started the sign-in, was closed, and the OS has now
      // launched it with the callback. The persisted attempt still holds the
      // verifier, so the exchange can happen directly.
      if (await serviceResumeFromColdStart(handlers)) return;

      // Case 2: a deep link arrived with nothing to match — a sign-in started
      // on the website, an expired attempt, or a wiped data dir. Re-initiate
      // rather than dead-ending: the browser already holds a session, so the
      // round-trip completes without a second login.
      if (await serviceHadLaunchUrl()) {
        await useAuthStore.getState().beginBrowserLogin();
      }
    } catch (err) {
      // Startup path — never block the app from opening over this.
      console.warn('[auth] cold-start resume failed', err);
    }
  },

  logout: async () => {
    serviceCancelBrowserLogin();
    await authClient.logout();
    set({
      loggedIn: false, email: null, plan: null, credits: null, usage: null, planGrant: null,
      token: null, loginStatus: 'idle', error: null,
    });
    void emit('auth-changed');
    // Dynamic import (not static): a static import here would cycle back
    // against server-config.ts's own import of this store for the auth
    // token. See stores/server-config.ts's header.
    void import('./server-config').then((m) => m.useServerConfigStore.getState().clear());
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
      set({
        loggedIn: false, email: null, plan: null, credits: null, usage: null, planGrant: null,
        token: null, error: null,
      });
      void import('./server-config').then((m) => m.useServerConfigStore.getState().clear());
      return;
    }

    if (isJwtExpired(stored.token)) {
      await authClient.logout().catch(() => {});
      set({
        loggedIn: false, email: null, plan: null, credits: null, usage: null, planGrant: null,
        token: null, error: null,
      });
      void import('./server-config').then((m) => m.useServerConfigStore.getState().clear());
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
      set({
        plan: u.plan,
        credits: u.credits.balance,
        usage: { planBalance: u.credits.plan, topupBalance: u.credits.topup },
      });
      // Fire-and-forget: refreshUsage already runs on login, session-restore,
      // Account mount, and stream 402s, so this is the natural place to keep
      // /v1/config fresh too. Dynamic import — see stores/server-config.ts's
      // header for why a static one would cycle.
      void import('./server-config').then((m) => m.useServerConfigStore.getState().refresh());
      // Best-effort, independently of the block above: a failed grant lookup
      // must not touch `usage`/`credits` — it only ever leaves `planGrant`
      // (and therefore the usage PERCENTAGE) unset, ISOLATED from the balance
      // this try/catch already landed.
      void planGrantsClient.getGrant(u.plan).then((grant) => set({ planGrant: grant }));
    } catch {
      // Best-effort — a transient failure must not clear a known balance.
    }
  },

  openBilling: async () => {
    await openUrl(`${ARCANE_WEB_URL}/account`).catch(() => {});
  },
}));
