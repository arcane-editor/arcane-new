// Auth API client. In-app credential login/signup was removed in Phase 3
// (browser-based deep-link login, spec Part C); the device-code flow stays
// as the fallback for environments without deep links (macOS `tauri dev`).
// The old X-Refreshed-Token handling was dead code (the server never sends
// that header) and was removed with it (spec C6 optional cleanup).
import { invoke } from '@tauri-apps/api/core';
import { ARCANE_API_URL } from '../../../config/api';

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenResult {
  status: 'authorized' | 'pending' | 'expired';
  token?: string;
  user?: { email: string; plan: string };
}

export interface ExchangeResult {
  success: boolean;
  error?: string;
  user?: { id: string; email: string; role: string; emailVerified: boolean };
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

      const data = (await res.json()) as {
        token: string;
        user: { id: string; email: string; role: string; emailVerified: boolean };
      };
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

  async requestDeviceCode(): Promise<DeviceCodeResponse> {
    const res = await fetch(`${this.serverUrl}/v1/auth/device/code`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
    });

    if (!res.ok) {
      throw new Error(`Failed to request device code (${res.status})`);
    }

    return res.json() as Promise<DeviceCodeResponse>;
  }

  async pollDeviceToken(deviceCode: string): Promise<DeviceTokenResult> {
    const res = await fetch(`${this.serverUrl}/v1/auth/device/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ device_code: deviceCode }),
    });

    if (!res.ok) {
      throw new Error(`Device token poll failed (${res.status})`);
    }

    const data = (await res.json()) as DeviceTokenResult;

    if (data.status === 'authorized' && data.token && data.user) {
      await this.saveToken(data.token, data.user.email);
    }

    return data;
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

  async logout(): Promise<void> {
    await invoke('auth_delete_token');
  }

  private async saveToken(token: string, email: string): Promise<void> {
    await invoke('auth_write_token', { token, email });
  }
}

export const authClient = new AuthClient();
