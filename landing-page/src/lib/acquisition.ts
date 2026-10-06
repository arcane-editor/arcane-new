/** First-touch acquisition only. Never retain query strings, search terms or auth URLs. */
export interface Acquisition {
  source: string;
  medium: string;
  landingPath: string;
  referrerHost?: string;
}

export const ACQUISITION_KEY = 'unityide_acquisition_v1';
const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const LIVE_HOSTS = new Set(['unityide.app', 'www.unityide.app']);
const PUBLIC_PATH = /^\/(?:$|(?:features|pricing|docs|blog|compare|about|privacy|terms|feedback)(?:\/|$))/;
const LABEL = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const HOST = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

export function validateAcquisition(value: unknown): Acquisition | undefined {
  if (!value || typeof value !== 'object') return;
  const data = value as Record<string, unknown>;
  if (typeof data.source !== 'string' || !LABEL.test(data.source) ||
      typeof data.medium !== 'string' || !LABEL.test(data.medium) ||
      typeof data.landingPath !== 'string' || data.landingPath.length > 200 ||
      !PUBLIC_PATH.test(data.landingPath) || !/^\/[a-zA-Z0-9/_\-.]*$/.test(data.landingPath)) return;
  const referrerHost = typeof data.referrerHost === 'string' &&
    data.referrerHost.length <= 253 && HOST.test(data.referrerHost) ? data.referrerHost : undefined;
  return { source: data.source, medium: data.medium, landingPath: data.landingPath,
    ...(referrerHost ? { referrerHost } : {}) };
}

function searchSource(host: string): string | undefined {
  if (/^(?:www\.)?google\.(?:com|co\.in|co\.uk|com\.au|ca|de|fr|es|it|co\.jp|com\.br)$/.test(host)) return 'google';
  if (host === 'bing.com' || host === 'www.bing.com') return 'bing';
  if (host === 'duckduckgo.com' || host === 'www.duckduckgo.com') return 'duckduckgo';
  if (host === 'search.yahoo.com') return 'yahoo';
  return undefined;
}

/** Unknown search hosts remain referrals, rather than inventing organic attribution. */
export function deriveAcquisition(href: string, referrer: string): Acquisition | undefined {
  let url: URL;
  try { url = new URL(href); } catch { return; }
  if (!LIVE_HOSTS.has(url.hostname) || !PUBLIC_PATH.test(url.pathname)) return;
  let referrerHost: string | undefined;
  try { referrerHost = new URL(referrer).hostname.toLowerCase(); } catch { /* Direct/unknown. */ }
  const internal = referrerHost === 'unityide.app' || referrerHost?.endsWith('.unityide.app');
  const params = url.searchParams;
  let source: string;
  let medium: string;
  // Paid clicks must not be reclassified as organic by a search-engine referrer.
  if (['gclid', 'gbraid', 'wbraid'].some((key) => params.has(key))) {
    source = 'google'; medium = 'cpc';
  } else if (params.has('msclkid')) {
    source = 'bing'; medium = 'cpc';
  } else if (params.has('rdt_cid')) {
    source = 'reddit'; medium = 'paid_social';
  } else if (params.has('utm_source') || params.has('utm_medium')) {
    const candidateSource = params.get('utm_source')?.toLowerCase() ?? '';
    const candidateMedium = params.get('utm_medium')?.toLowerCase() ?? '';
    source = LABEL.test(candidateSource) ? candidateSource : 'unknown';
    medium = LABEL.test(candidateMedium) ? candidateMedium : 'unknown';
  } else if (internal) {
    // Opening a docs link or returning from app auth does not create a new touch.
    return;
  } else if (referrerHost) {
    source = searchSource(referrerHost) ?? 'referral';
    medium = searchSource(referrerHost) ? 'organic' : 'referral';
  } else {
    source = 'direct'; medium = 'none';
  }
  return validateAcquisition({ source, medium, landingPath: url.pathname,
    referrerHost: internal ? undefined : referrerHost });
}

export function readAcquisition(storage: Pick<Storage, 'getItem' | 'removeItem'>, now = Date.now()): Acquisition | undefined {
  try {
    const raw = storage.getItem(ACQUISITION_KEY);
    if (!raw) return;
    const data = JSON.parse(raw);
    if (typeof data.capturedAt !== 'number' || data.capturedAt > now || now - data.capturedAt >= MAX_AGE_MS) {
      storage.removeItem(ACQUISITION_KEY); return;
    }
    return validateAcquisition(data.acquisition);
  } catch { return; }
}

function trackingDisabled(): boolean {
  return typeof navigator !== 'undefined' &&
    ((navigator as Navigator & { globalPrivacyControl?: boolean }).globalPrivacyControl === true || navigator.doNotTrack === '1');
}

export function currentAcquisition(): Acquisition | undefined {
  if (typeof window === 'undefined') return;
  try {
    if (!LIVE_HOSTS.has(window.location.hostname) || trackingDisabled()) return;
    return readAcquisition(window.localStorage);
  } catch { return; }
}

export function captureAcquisition(): void {
  if (typeof window === 'undefined') return;
  try {
    if (trackingDisabled()) { window.localStorage.removeItem(ACQUISITION_KEY); return; }
    if (currentAcquisition()) return;
    const acquisition = deriveAcquisition(window.location.href, document.referrer);
    if (acquisition) window.localStorage.setItem(ACQUISITION_KEY, JSON.stringify({ capturedAt: Date.now(), acquisition }));
  } catch { /* Storage blocking must never interrupt navigation or sign-in. */ }
}

export function acquisitionQuery(acquisition = currentAcquisition()): string {
  if (!acquisition) return '';
  const params = new URLSearchParams({ acq_source: acquisition.source, acq_medium: acquisition.medium,
    acq_landing_path: acquisition.landingPath });
  if (acquisition.referrerHost) params.set('acq_referrer_host', acquisition.referrerHost);
  return `&${params.toString()}`;
}
