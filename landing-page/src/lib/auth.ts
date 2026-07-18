const API_URL = import.meta.env.PUBLIC_API_URL || 'https://api.arcaneai.org';
const TOKEN_KEY = 'arcane_auth_token';

export interface AuthUser {
    id: number;
    email: string;
    role: string;
    emailVerified: boolean;
}

export interface AuthResponse {
    token: string;
    user: AuthUser;
}

export interface MeResponse {
    user: AuthUser;
    hasPassword: boolean;
    googleLinked: boolean;
    usage: {
        totalRequests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
    };
}

// ─── Error messages ─────────────────────────────────────────
// Single source of truth mapping server error codes (and the one prose-string
// quirk: login returns `Invalid credentials`, not a code) to friendly copy.
// Also covers the ?error= values the Google redirect can land with.

const ERROR_MESSAGES: Record<string, string> = {
    'Invalid credentials': 'Incorrect email or password.',
    invalid_credentials: 'Incorrect email or password.',
    use_google: 'This account signs in with Google. Use "Continue with Google" instead.',
    google_account: 'An account with this email already uses Google sign-in. Use "Continue with Google".',
    invalid_email: "That doesn't look like a valid email address.",
    weak_password: 'Password must be at least 8 characters.',
    invalid_token: 'This link is invalid or has expired. Request a new one and try again.',
    resend_throttled: "You've requested too many verification emails. Try again in an hour.",
    invalid_code: 'This code is invalid or has expired. Start the sign-in again.',
    invalid_challenge: "The editor's sign-in request was invalid. Return to Arcane and click Sign in again.",
    no_password_set: 'This account has no password yet. Use "Set a password" on your account page.',
    turnstile_failed: 'Human verification failed. Refresh the page and try again.',
    google_not_configured: "Google sign-in isn't set up yet. Use email and password instead.",
    google_oauth_failed: 'Google sign-in failed. Please try again.',
};

export function authErrorMessage(codeOrMessage: string | undefined | null): string {
    if (!codeOrMessage) return 'Something went wrong. Please try again.';
    return ERROR_MESSAGES[codeOrMessage] ?? codeOrMessage;
}

// ─── Token Storage ──────────────────────────────────────────

export function getStoredToken(): string | null {
    if (typeof window === 'undefined') return null;
    return localStorage.getItem(TOKEN_KEY);
}

export function setStoredToken(token: string): void {
    localStorage.setItem(TOKEN_KEY, token);
}

export function clearStoredToken(): void {
    localStorage.removeItem(TOKEN_KEY);
}

// ─── JWT Decode (client-side only) ──────────────────────────

export function decodeToken(token: string): { sub: string; email: string; role: string } | null {
    try {
        const parts = token.split('.');
        if (parts.length !== 3) return null;
        const payload = JSON.parse(atob(parts[1]!.replace(/-/g, '+').replace(/_/g, '/')));
        return payload;
    } catch {
        return null;
    }
}

// ─── API Calls ──────────────────────────────────────────────

export async function apiLogin(email: string, password: string, turnstileToken?: string): Promise<AuthResponse> {
    const body: Record<string, string> = { email, password };
    if (turnstileToken) body['cf-turnstile-response'] = turnstileToken;
    const res = await fetch(`${API_URL}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Login failed');
    }
    return res.json();
}

export async function apiSignup(email: string, password: string, turnstileToken?: string): Promise<AuthResponse> {
    const body: Record<string, string> = { email, password };
    if (turnstileToken) body['cf-turnstile-response'] = turnstileToken;
    const res = await fetch(`${API_URL}/v1/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Signup failed');
    }
    return res.json();
}

export async function apiGetMe(token: string): Promise<MeResponse> {
    const res = await fetch(`${API_URL}/v1/auth/me`, {
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) throw new Error('Not authenticated');
    return res.json();
}

export async function apiAuthorizeDevice(token: string, userCode: string): Promise<void> {
    const res = await fetch(`${API_URL}/v1/auth/device/authorize`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ user_code: userCode }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Authorization failed');
    }
}

// ─── Phase 2b auth API calls ────────────────────────────────

export function googleStartUrl(returnTo: '/auth' | '/auth/device' | '/account'): string {
    // Full-page navigation target (302 to Google), NOT a fetch endpoint.
    // returnTo must be on the server's allowlist: /auth, /auth/device, /account.
    return `${API_URL}/v1/auth/google/start?return_to=${encodeURIComponent(returnTo)}`;
}

export async function apiWebExchange(code: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/web/exchange`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_code');
    }
    return res.json();
}

export async function apiEditorGrant(token: string, challenge: string): Promise<{ code: string; expires_in: number }> {
    const res = await fetch(`${API_URL}/v1/auth/editor/grant`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ challenge }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_challenge');
    }
    return res.json();
}

export async function apiVerifyEmail(verifyToken: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: verifyToken }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_token');
    }
    return res.json();
}

export async function apiResendVerification(token: string): Promise<void> {
    const res = await fetch(`${API_URL}/v1/auth/resend-verification`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${token}` },
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Resend failed');
    }
}

export async function apiForgot(email: string): Promise<void> {
    // Server ALWAYS returns 200 {ok:true} (anti-enumeration); this throws only
    // on network/5xx failures.
    const res = await fetch(`${API_URL}/v1/auth/forgot`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }),
    });
    if (!res.ok) throw new Error('Request failed');
}

export async function apiReset(resetToken: string, newPassword: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/reset`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token: resetToken, newPassword }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_token');
    }
    return res.json();
}

export async function apiChangePassword(token: string, currentPassword: string, newPassword: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/change-password`, {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${token}`,
        },
        body: JSON.stringify({ currentPassword, newPassword }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'invalid_credentials');
    }
    return res.json();
}

// ─── Admin API Calls ────────────────────────────────────────

function adminHeaders(token: string) {
    return {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`,
    };
}

export async function adminGetUsers(token: string) {
    const res = await fetch(`${API_URL}/v1/admin/users`, { headers: adminHeaders(token) });
    if (!res.ok) throw new Error('Failed to fetch users');
    return res.json();
}

export async function adminCreateUser(token: string, data: { email: string; password: string }) {
    const res = await fetch(`${API_URL}/v1/admin/users`, {
        method: 'POST',
        headers: adminHeaders(token),
        body: JSON.stringify(data),
    });
    if (!res.ok) {
        const d = await res.json();
        throw new Error(d.error || 'Failed to create user');
    }
    return res.json();
}

export async function adminUpdateUser(token: string, id: number, data: { password?: string }) {
    const res = await fetch(`${API_URL}/v1/admin/users/${id}`, {
        method: 'PUT',
        headers: adminHeaders(token),
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error('Failed to update user');
    return res.json();
}

export async function adminDeleteUser(token: string, id: number) {
    const res = await fetch(`${API_URL}/v1/admin/users/${id}`, {
        method: 'DELETE',
        headers: adminHeaders(token),
    });
    if (!res.ok) throw new Error('Failed to delete user');
    return res.json();
}

export async function adminGetFeedback(token: string) {
    const res = await fetch(`${API_URL}/v1/admin/feedback`, { headers: adminHeaders(token) });
    if (!res.ok) throw new Error('Failed to fetch feedback');
    return res.json();
}
