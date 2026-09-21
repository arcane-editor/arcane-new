export const SITE_URL = 'https://unityide.app';
export const DEFAULT_TITLE = 'UnityIDE — Free IDE for Unity with AI Assistance';
export const DEFAULT_DESCRIPTION =
  'Build Unity projects with C# editing, prefab and asset tools, and AI assistance connected to the Unity Editor. Free for Windows and macOS.';

/** Match Pages' directory URLs; never carry acquisition or authentication parameters. */
export function canonicalUrl(pathname: string, site = SITE_URL): string {
  const path = pathname === '/' || /\.[a-z0-9]+$/i.test(pathname)
    ? pathname
    : `${pathname.replace(/\/+$/, '')}/`;
  return new URL(path, site).href;
}

export function pageTitle(title: string): string {
  return /\bUnityIDE\b/.test(title) ? title : `${title} — UnityIDE`;
}

/** A JSON-LD string must not be able to close its HTML script element. */
export function jsonLd(data: Record<string, unknown>): string {
  return JSON.stringify(data).replace(/</g, '\\u003c');
}
