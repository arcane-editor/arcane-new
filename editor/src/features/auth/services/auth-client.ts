// Auth API client — ported from arcane-auth-service-impl.ts
import { invoke } from '@tauri-apps/api/core';
import { ARCANE_API_URL } from '../../../config/api';

interface AuthResult {
  success: boolean;
  error?: string;
  user?: { email: string; plan: string; credits: number; price: number };
}

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

  async login(email: string, password: string): Promise<AuthResult> {
    try {
      const res = await fetch(`${this.serverUrl}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        return { success: false, error: data.error ?? `Login failed (${res.status})` };
      }

      const data = await res.json() as { token: string; user: AuthResult['user'] };
      await this.saveToken(data.token, data.user!.email);
      this.handleRefreshToken(res, data.user!.email);

      return { success: true, user: data.user };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }

  async signup(email: string, password: string, promoCode?: string): Promise<AuthResult> {
    try {
      const body: Record<string, string> = { email, password };
      if (promoCode) body.promoCode = promoCode;

      const res = await fetch(`${this.serverUrl}/v1/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });

      if (!res.ok) {
        const data = await res.json() as { error?: string };
        return { success: false, error: data.error ?? `Signup failed (${res.status})` };
      }

      const data = await res.json() as { token: string; user: AuthResult['user'] };
      await this.saveToken(data.token, data.user!.email);

      return { success: true, user: data.user };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
    }
  }

  /**
   * Redeem the one-time grant code from the browser flow (deep link or
   * manual paste — same code either way) for a full session token.
   * The server returns a single opaque `invalid_code` for every failure
   * mode (expired, replayed, verifier mismatch) by design.
   */
  async exchangeEditorCode(code: string, verifier: string): Promise<ExchangeResult> {
    try {
      const res = await fetch(`${this.serverUrl}/v1/auth/editor/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, verifier }),
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
      return { success: false, error: err instanceof Error ? err.message : 'Network error' };
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

    const data = await res.json() as DeviceTokenResult;

    if (data.status === 'authorized' && data.token && data.user) {
      await this.saveToken(data.token, data.user.email);
    }

    return data;
  }

  async loadFromDisk(): Promise<{ token: string; email: string } | null> {
    try {
      const result = await invoke<{ token: string; email: string } | null>('auth_read_token');
      return result;
    } catch {
      return null;
    }
  }

  async logout(): Promise<void> {
    await invoke('auth_delete_token');
  }

  private async saveToken(token: string, email: string): Promise<void> {
    await invoke('auth_write_token', { token, email });
  }

  private async handleRefreshToken(res: Response, email: string): Promise<void> {
    const refreshedToken = res.headers.get('X-Refreshed-Token');
    if (refreshedToken) {
      await this.saveToken(refreshedToken, email);
    }
  }
}

export const authClient = new AuthClient();
