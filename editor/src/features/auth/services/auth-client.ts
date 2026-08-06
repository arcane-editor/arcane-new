// Auth API client. In-app credential login/signup was removed in Phase 3
// (browser-based login, spec Part C). Browser sign-in works on every platform:
// a deep link where the scheme is registered, loopback otherwise (including
// macOS `tauri dev`), and a PKCE-bound poll channel where neither can be
// delivered. The device-code flow was deleted in 0017 — it was a second login
// path with no PKCE binding at all.
// The old X-Refreshed-Token handling was dead code (the server never sends
// that header) and was removed with it (spec C6 optional cleanup).
import { invoke } from '@tauri-apps/api/core';
import { ARCANE_API_URL } from '../../../config/api';
import type { SessionUser } from './session-types';

/** Mirrors the server's makeUserResponse() exactly. `plan` and `credits` were
 *  previously missing from this type — the runtime already carried them, but
 *  nothing could read them, so the store hardcoded `plan: null` and paid for a
 *  redundant /v1/usage round-trip (showing "—" in the account view until it
 *  landed). `id` is a number, as the server sends it. */
export type ExchangeUser = SessionUser;

export interface ExchangeResult {
  success: boolean;
  error?: string;
  user?: ExchangeUser;
}

export interface UsageSummary {
  plan: string;
  credits: { balance: number; plan: number; topup: number };
  planPeriodEnd: string | null;
}

export class AuthClient {
  private serverUrl: string = ARCANE_API_URL;

  /**
   * Redeem the one-time grant code from the browser flow (deep link or
   * manual paste — same code either way) for a full session token.
   * The server returns a single opaque `invalid_code` for every failure
   * mode (expired, replayed, verifier mismatch) by design.
   *
   * `timeoutMs` bounds a hung connection (no AbortController previously —
   * a stalled request left AuthTab stuck on the 'exchanging' spinner
   * forever); overridable for tests, same pattern as browser-login's
   * `beginBrowserLogin(handlers, timeoutMs)`.
   */
  async exchangeEditorCode(
    code: string,
    verifier: string,
    timeoutMs: number = 30_000,
  ): Promise<ExchangeResult> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.serverUrl}/v1/auth/editor/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
        signal: controller.signal,
      });

      if (!res.ok) {
        const data = (await res.json().catch(() => ({}))) as { error?: string };
        return {
          success: false,
          error:
            data.error === 'invalid_code'
              ? 'Invalid or expired code. Start the sign-in again.'
              : `Sign-in failed (${res.status})`,
        };
      }

      const data = (await res.json()) as { token: string; user: ExchangeUser };
      await this.saveToken(data.token, data.user.email);
      return { success: true, user: data.user };
    } catch (err) {
      // Same opaque failure shape whether the connection was aborted (hung
      // past `timeoutMs`) or failed outright — the store treats every catch
      // here as a retryable 'error' state, not a stuck spinner.
      if (err instanceof Error && err.name === 'AbortError') {
        return { success: false, error: 'Sign-in timed out. Check your connection and try again.' };
      }
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * `auth_read_token` (Rust) distinguishes "no token file" — resolves
   * `Ok(None)`, i.e. this promise resolves `null` — from a genuine
   * read/parse error, which the invoke call REJECTS. Only the former is a
   * legitimate "signed out" signal, so this method must NOT swallow a
   * rejection into `null`: doing so would make a transient disk hiccup
   * indistinguishable from a real logout and let the caller wipe a live
   * session on it. Let rejections propagate — the auth store's
   * `loadFromDisk` action is what decides how to react to each case.
   */
  async loadFromDisk(): Promise<{ token: string; email: string } | null> {
    return invoke<{ token: string; email: string } | null>('auth_read_token');
  }

  /** Plan + credit balance for the signed-in user. Read-only; used by the
   *  Account tab and the out-of-credits path. Throws on any non-2xx. */
  async fetchUsage(token: string): Promise<UsageSummary> {
    const res = await fetch(`${this.serverUrl}/v1/usage`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`Usage fetch failed (${res.status})`);
    return res.json() as Promise<UsageSummary>;
  }

  /**
   * Re-send the verification email for the signed-in user. The server
   * throttles this to 3 per hour (countRecentAuthTokens) and answers 429
   * `resend_throttled`; that is mapped here so the panel can render it
   * verbatim. A user who is already verified gets a plain `ok`.
   */
  async resendVerification(token: string): Promise<void> {
    const res = await fetch(`${this.serverUrl}/v1/auth/resend-verification`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    });
    if (res.ok) return;
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (data.error === 'resend_throttled') {
      throw new Error("You've requested several emails already. Try again in an hour.");
    }
    throw new Error(data.error ?? `Could not resend the email (${res.status})`);
  }

  async logout(): Promise<void> {
    await invoke('auth_delete_token');
  }

  /** Persist a session token. Public because the poll channel completes
   *  outside exchangeEditorCode and still has to land the token on disk. */
  async saveToken(token: string, email: string): Promise<void> {
    await invoke('auth_write_token', { token, email });
  }
}

export const authClient = new AuthClient();
