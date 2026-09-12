import { openUrl } from '@tauri-apps/plugin-opener';

/**
 * Links out to the OS browser.
 *
 * A webview is not a browser tab. A bare `<a href="https://…">` has no browser
 * to hand the URL to, so the click either navigates THIS webview away from the
 * app — taking the whole session with it — or is silently dropped.
 * `target="_blank"` does not help: there is no window to open into. The only
 * route out is `@tauri-apps/plugin-opener`, which asks the OS.
 *
 * Every link a user can click that was not hand-written as a button is
 * generated: by the two react-markdown renderers (`AssistantMessage`,
 * `MarkdownPreview` — neither overrode `a`) or by Monaco's link detector on a
 * URL sitting in a comment. None of those can author an onClick. So this is
 * intercepted centrally — a capture-phase document listener plus a Monaco link
 * opener — rather than as a component override that every future renderer
 * would have to remember to add.
 */

/**
 * Exactly the schemes `opener:default` grants, via `allow-default-urls` in
 * `src-tauri/capabilities/default.json`.
 *
 * Not a stylistic allowlist. Handing the opener a scheme outside its scope
 * throws, and `javascript:` in particular would be an execution sink for
 * MODEL-authored markdown. Anything outside this set keeps the behaviour it
 * has today: inert. Widen it here and in the capability together, or not at
 * all.
 */
const EXTERNAL_SCHEMES = new Set(['http:', 'https:', 'mailto:', 'tel:']);

const SCHEME = /^([a-z][a-z0-9+.-]*):/i;

/**
 * Whether an href names one of the schemes we send to the OS.
 *
 * Takes the raw `href` **attribute**, never `HTMLAnchorElement.href`: the DOM
 * resolves the property against the page, and in a packaged build the page is
 * `http://tauri.localhost/`. A `#section` jump would come back as
 * `http://tauri.localhost/#section` — external by this test, and shipped to
 * the browser instead of scrolling the document.
 */
export function isExternalUrl(href: string | null | undefined): boolean {
  if (!href) return false;
  const scheme = SCHEME.exec(href.trim());
  if (!scheme) return false; // relative, root-relative or a bare fragment
  return EXTERNAL_SCHEMES.has(`${scheme[1].toLowerCase()}:`);
}

/** The parts of a click this decision actually depends on. */
export interface LinkClick {
  defaultPrevented: boolean;
  /** `MouseEvent.button`: 0 left, 1 middle, 2 right. */
  button: number;
  /** The anchor's raw `href` attribute, or null if the click missed a link. */
  href: string | null;
  hasDownload: boolean;
}

/**
 * The URL to hand the OS, or null to leave the click alone.
 *
 * Split out from the listener so it is testable without a DOM — this codebase
 * has no jsdom, and the interesting cases are all here rather than in
 * `addEventListener`.
 */
export function externalTarget(click: LinkClick): string | null {
  // Something nearer the element already claimed it.
  if (click.defaultPrevented) return null;
  // Left and middle only. Right-click must reach the context menu.
  if (click.button !== 0 && click.button !== 1) return null;
  if (click.hasDownload) return null;
  return isExternalUrl(click.href) ? click.href : null;
}

/**
 * The URL to hand the OS for a link Monaco detected.
 *
 * Monaco gives its link opener a `Uri`, and both of its spellings are wrong on
 * their own — verified against monaco-editor 0.55.1, not reasoned about:
 *
 *   in   https://example.com/s?q=unity&page=2
 *   str  https://example.com/s?q%3Dunity%26page%3D2   <- toString()
 *   raw  https://example.com/s?q=unity&page=2         <- toString(true)
 *
 *   in   https://example.com/a%20b?x=1
 *   raw  https://example.com/a b?x=1                  <- toString(true)
 *
 * `toString()` runs the query through `encodeURIComponentFast`, whose
 * `encodeTable` holds `=` and `&`, so every query collapses to a single
 * key. `toString(true)` skips that but hands back the DECODED path, so a
 * `%20` arrives as a bare space. `encodeURI` puts exactly those back while
 * leaving the reserved characters a URL needs to keep — and because the raw
 * form is fully decoded, it re-encodes a literal `%` correctly too rather
 * than double-escaping one that was already an escape.
 */
export function browserUrlFor(resource: { toString(skipEncoding?: boolean): string }): string {
  return encodeURI(resource.toString(true));
}

/** Hands a URL to the OS. Returns whether it went. */
export async function openExternal(href: string): Promise<boolean> {
  if (!isExternalUrl(href)) return false;
  try {
    await openUrl(href);
    return true;
  } catch (err) {
    // A dead link should not surface as the app's "Unexpected error" toast.
    console.warn('[external-link] could not open', href, err);
    return false;
  }
}

/**
 * Routes every external anchor click in this window to the browser.
 *
 * Capture phase, on `document`: React attaches its listeners to `#root`, below
 * this, so capturing here runs first and cannot be cut off by a
 * `stopPropagation` in some component's own handler. `preventDefault` is the
 * point of it — without that the webview navigates and the app is gone.
 *
 * Returns a teardown so a test or a hot reload can remove it.
 */
export function installExternalLinkHandler(target: Document = document): () => void {
  const onClick = (event: MouseEvent) => {
    const el = event.target as Element | null;
    const anchor = el && typeof el.closest === 'function'
      ? (el.closest('a[href]') as HTMLAnchorElement | null)
      : null;
    const url = externalTarget({
      defaultPrevented: event.defaultPrevented,
      button: event.button,
      href: anchor ? anchor.getAttribute('href') : null,
      hasDownload: !!anchor?.hasAttribute('download'),
    });
    if (!url) return;
    event.preventDefault();
    void openExternal(url);
  };

  target.addEventListener('click', onClick, true);
  // Middle-click fires `auxclick`, not `click`. Left unhandled it navigates
  // nowhere at all, which reads as the same dead link.
  target.addEventListener('auxclick', onClick, true);

  return () => {
    target.removeEventListener('click', onClick, true);
    target.removeEventListener('auxclick', onClick, true);
  };
}
