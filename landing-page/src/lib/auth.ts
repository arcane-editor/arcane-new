const API_URL = import.meta.env.PUBLIC_API_URL || 'https://api.arcaneai.org';
const TOKEN_KEY = 'arcane_auth_token';

export interface AuthUser {
    id: number;
    email: string;
    role: string;
}

export interface AuthResponse {
    token: string;
    user: AuthUser;
}

export interface MeResponse {
    user: AuthUser;
    usage: {
        totalRequests: number;
        totalInputTokens: number;
        totalOutputTokens: number;
    };
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

export async function apiLogin(email: string, password: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
        const data = await res.json();
        throw new Error(data.error || 'Login failed');
    }
    return res.json();
}

export async function apiSignup(email: string, password: string): Promise<AuthResponse> {
    const res = await fetch(`${API_URL}/v1/auth/signup`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
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
