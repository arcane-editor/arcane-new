/**
 * Classifying the two failure modes an ACP agent reports out-of-band.
 *
 * Both are pure string/shape predicates so they can be unit-tested without a
 * running agent.
 */

import { ACP_AUTH_REQUIRED } from './protocol';

export interface JsonRpcErrorBody {
  code: number;
  message: string;
  data?: unknown;
}

/** Error carrying the agent's JSON-RPC failure, so callers can branch on `code`. */
export class AcpRequestError extends Error {
  readonly code: number;
  readonly data: unknown;
  readonly method: string;

  constructor(method: string, body: JsonRpcErrorBody) {
    super(body.message || `ACP ${method} failed`);
    this.name = 'AcpRequestError';
    this.method = method;
    this.code = body.code;
    this.data = body.data;
  }
}

/**
 * Thrown by a client-side request handler for a method we do not implement, so
 * the transport can answer with JSON-RPC's `-32601` rather than a generic
 * internal error. The distinction matters: `-32601` is the answer capability
 * negotiation is built around, and a well-behaved agent treats it as "this
 * client cannot do that, work around it" instead of "the client is broken".
 */
export class AcpMethodNotFoundError extends Error {
  constructor(readonly method: string) {
    super(`Unsupported method: ${method}`);
    this.name = 'AcpMethodNotFoundError';
  }
}

/**
 * `-32000` is ACP's reserved "Authentication required". The agent returns it
 * from `session/new` (and sometimes `session/prompt`) when the user has not
 * signed in to the underlying provider yet.
 */
export function isAuthRequired(error: unknown): boolean {
  return error instanceof AcpRequestError && error.code === ACP_AUTH_REQUIRED;
}

/**
 * Claude's credentials can expire *mid-turn*, in which case there is no
 * JSON-RPC error to catch — the agent just streams assistant text saying so and
 * ends the turn normally. The adapter emits these verbatim from the CLI, and
 * checks for this exact substring itself, so matching it is not a guess.
 *
 * Matching is deliberately narrow: a broad /login|auth/ test would misfire on
 * any turn that happens to discuss authentication code.
 */
const EXPIRED_MARKERS = [
  'please run /login',
  'session expired. please run /login',
  'not logged in',
  'invalid api key',
];

export function looksLikeExpiredAuth(text: string): boolean {
  if (!text) return false;
  const haystack = text.toLowerCase();
  return EXPIRED_MARKERS.some((m) => haystack.includes(m));
}

/**
 * Turn any thrown value into a message safe to show a user. Tauri rejects
 * `invoke` with a bare string, which `String(e)` would render as
 * "[object Object]" if it were ever an object instead.
 */
export function toMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}
