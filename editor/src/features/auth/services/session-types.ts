// The one user shape every sign-in path produces. Lives in its own module so
// browser-login.ts can reference it without importing auth-client — keeping
// the property browser-login's header claims: no auth-client/store
// dependencies, testable under bun with only Tauri API mocks.

/** Mirrors the server's makeUserResponse() exactly. */
export interface SessionUser {
  id: number;
  email: string;
  role: string;
  emailVerified: boolean;
  plan: string;
  credits: number;
}

/** A completed session, as returned by /v1/auth/editor/exchange and /poll. */
export interface Session {
  token: string;
  user: SessionUser;
}
