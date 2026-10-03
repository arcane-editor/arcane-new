export const SITE_URL = 'https://unityide.app';
export const DEFAULT_TITLE = 'UnityIDE — Free Unity IDE with AI Agents';
export const DEFAULT_DESCRIPTION =
  'Edit C#, inspect scenes and prefabs, and work with AI agents in UnityIDE. Free Unity IDE for Windows and macOS with a connected Unity Editor workflow.';

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
