import { create } from 'zustand';
import { authClient } from '../features/auth';

interface AuthState {
  loggedIn: boolean;
  email: string | null;
  plan: string | null;
  token: string | null;
  loading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<boolean>;
  signup: (email: string, password: string, promoCode?: string) => Promise<boolean>;
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
  loading: false,
  error: null,

  login: async (email: string, password: string) => {
    set({ loading: true, error: null });
    const result = await authClient.login(email, password);
    if (result.success && result.user) {
      const stored = await authClient.loadFromDisk().catch(() => null);
      set({
        loggedIn: true,
        email: result.user.email,
        plan: result.user.plan,
        token: stored?.token ?? null,
        loading: false,
        error: null,
      });
      return true;
    } else {
      set({ loading: false, error: result.error ?? 'Login failed' });
      return false;
    }
  },

  signup: async (email: string, password: string, promoCode?: string) => {
    set({ loading: true, error: null });
    const result = await authClient.signup(email, password, promoCode);
    if (result.success && result.user) {
      const stored = await authClient.loadFromDisk().catch(() => null);
      set({
        loggedIn: true,
        email: result.user.email,
        plan: result.user.plan,
        token: stored?.token ?? null,
        loading: false,
        error: null,
      });
      return true;
    } else {
      set({ loading: false, error: result.error ?? 'Signup failed' });
      return false;
    }
  },

  logout: async () => {
    await authClient.logout();
    set({ loggedIn: false, email: null, plan: null, token: null, error: null });
  },

  loadFromDisk: async () => {
    const stored = await authClient.loadFromDisk();
    if (!stored) return;

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
