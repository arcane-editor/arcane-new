/**
 * Crash reporting — ships an uncaught client error to `POST /v1/client-error`,
 * where it lands in Workers Logs (live tail) and the `client_errors` table
 * (durable).
 *
 * This exists because a packaged build has no console. `ErrorBoundary` already
 * keeps the message and component stack on screen for the person hitting the
 * crash; this is the other half — the report reaching someone who can fix it,
 * without asking a user to attach a debugger to a WebView.
 *
 * Three properties are load-bearing, and each has a test:
 *
 *  1. **It never throws.** `report()` runs inside `componentDidCatch`. A throw
 *     there escalates a contained panel crash into a blank window, which is
 *     strictly worse than the crash it was reporting.
 *  2. **It is bounded.** "Maximum update depth exceeded" re-throws on every
 *     render. Un-capped, one bad component turns a single session into a flood.
 *     Identical crashes are deduplicated and the session is capped outright.
 *  3. **It scrubs home directories.** Stacks and workspace paths carry
 *     `C:\Users\<name>\…`. The report needs the shape of the path, never whose
 *     machine it was.
 */

import { API_URL } from '../config/api';

export interface CrashMeta {
  appVersion: string;
  channel: string;
  os: string;
  sessionId: string;
}

export interface CrashInput {
  /** Where it came from: 'react-error-boundary' | 'window-error' | 'unhandled-rejection'. */
  kind: string;
  message: string;
  stack?: string;
  componentStack?: string;
}

interface CrashReporterConfig {
  fetchImpl?: typeof fetch;
  baseUrl?: string;
  /** May be async: the production resolver imports the auth store lazily so
   *  this module stays loadable without the store graph. */
  getToken?: () => string | null | Promise<string | null>;
  meta?: () => CrashMeta | Promise<CrashMeta>;
  maxPerSession?: number;
}

/** Mirrors the server's caps in `routes/client-error.ts` — the server truncates
 *  too (it cannot trust a client), but sending 40KB we know will be cut is
 *  wasted bytes off a machine that is already in trouble. */
const LIMITS = { message: 2_048, stack: 8_192, componentStack: 8_192 } as const;

const DEFAULT_MAX_PER_SESSION = 5;

/**
 * Replace a user home directory with `~`. Windows, macOS and Linux shapes.
 * The trailing path is kept — `~\Documents\game` still tells you where the
 * project sat, without naming the account.
 */
export function scrubHomePaths(text: string): string {
  return text
    .replace(/[A-Za-z]:\\Users\\[^\\/\s"']+/g, '~')
    .replace(/\/Users\/[^/\s"']+/g, '~')
    .replace(/\/home\/[^/\s"']+/g, '~');
}

function truncate(value: string | undefined, max: number): string {
  if (!value) return '';
  if (value.length <= max) return value;
  return `${value.slice(0, max)}… [truncated ${value.length - max} chars]`;
}

/** Message plus the first stack frame. Enough to collapse a render loop
 *  without collapsing two genuinely different crashes in the same component. */
function fingerprint(input: CrashInput): string {
  const firstFrame = (input.stack ?? '').split('\n').find((l) => l.trim())?.trim() ?? '';
  return `${input.kind}|${input.message}|${firstFrame}`;
}

export function createCrashReporter(config: CrashReporterConfig = {}) {
  const fetchImpl = config.fetchImpl ?? fetch;
  const baseUrl = config.baseUrl ?? API_URL;
  const maxPerSession = config.maxPerSession ?? DEFAULT_MAX_PER_SESSION;
  const getToken = config.getToken ?? (() => null);
  const resolveMeta = config.meta ?? defaultMeta;

  const seen = new Set<string>();
  let sentCount = 0;

  async function report(input: CrashInput): Promise<void> {
    try {
      if (sentCount >= maxPerSession) return;

      const key = fingerprint(input);
      if (seen.has(key)) return;
      seen.add(key);
      // Counted at the point of decision, not after the await: two crashes
      // racing on a slow network must not both slip past the cap.
      sentCount += 1;

      const meta = await resolveMeta();
      const token = await getToken();

      await fetchImpl(`${baseUrl}/v1/client-error`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify({
          kind: input.kind,
          message: scrubHomePaths(truncate(input.message, LIMITS.message)),
          stack: scrubHomePaths(truncate(input.stack, LIMITS.stack)),
          componentStack: scrubHomePaths(truncate(input.componentStack, LIMITS.componentStack)),
          ...meta,
        }),
        // The window may be closing right behind this crash.
        keepalive: true,
      });
    } catch {
      // Deliberately silent. See property (1) in this file's header — a report
      // that fails is a lost report, never a second crash.
    }
  }

  return { report };
}

// ---------------------------------------------------------------------------
// Production singleton
// ---------------------------------------------------------------------------

/** Identifies one app run, so a burst of reports can be read as one session. */
const SESSION_ID =
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : String(Date.now());

function detectOs(): string {
  const ua = typeof navigator === 'undefined' ? '' : navigator.userAgent;
  if (/Windows/i.test(ua)) return 'windows';
  if (/Mac OS X|Macintosh/i.test(ua)) return 'macos';
  if (/Linux/i.test(ua)) return 'linux';
  return 'unknown';
}

/** Derived from the endpoint this build targets rather than a separate flag:
 *  it is the same signal that decides which worker (and which D1) the report
 *  lands in, so the two can never disagree. */
function detectChannel(): string {
  return API_URL.includes('api-dev') ? 'dev' : 'release';
}

let cachedVersion: string | null = null;

async function defaultMeta(): Promise<CrashMeta> {
  if (cachedVersion === null) {
    try {
      // Imported lazily: this module is loaded by unit tests that have no
      // Tauri host, and a static import would drag one in.
      const { getVersion } = await import('@tauri-apps/api/app');
      cachedVersion = await getVersion();
    } catch {
      cachedVersion = '';
    }
  }
  return {
    appVersion: cachedVersion,
    channel: detectChannel(),
    os: detectOs(),
    sessionId: SESSION_ID,
  };
}

async function defaultToken(): Promise<string | null> {
  try {
    const { useAuthStore } = await import('../stores/auth');
    return useAuthStore.getState().token;
  } catch {
    return null;
  }
}

// Resolved per report, not once at boot: the user is typically signed out
// when the module loads and signed in by the time anything crashes.
const singleton = createCrashReporter({ getToken: defaultToken });

/** Report an uncaught client error. Safe to call from anywhere, including
 *  `componentDidCatch`; never throws and never rejects. */
export function reportCrash(input: CrashInput): void {
  void singleton.report(input);
}
