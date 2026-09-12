import { describe, it, expect } from 'bun:test';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { browserUrlFor, externalTarget, isExternalUrl } from './external-link';

const ROOT = path.resolve(import.meta.dir, '..');

/**
 * A webview has no browser tab to hand a URL to, so a bare `<a href>` either
 * navigates the app itself away or is dropped. Nothing in the app intercepted
 * anchor clicks — not the two react-markdown renderers (neither overrode `a`),
 * not Monaco's link detector, not a document listener, not `on_navigation` in
 * Rust — so every link that was not hand-written as a button was dead.
 */
describe('isExternalUrl', () => {
  it('accepts exactly the schemes the opener capability grants', () => {
    expect(isExternalUrl('https://unity.com')).toBe(true);
    expect(isExternalUrl('http://localhost:3000/docs')).toBe(true);
    expect(isExternalUrl('mailto:support@unityide.app')).toBe(true);
    expect(isExternalUrl('tel:+15551234')).toBe(true);
  });

  it('is case-insensitive about the scheme', () => {
    expect(isExternalUrl('HTTPS://unity.com')).toBe(true);
    expect(isExternalUrl('MailTo:a@b.c')).toBe(true);
  });

  it('refuses javascript: — this renders MODEL-authored markdown', () => {
    expect(isExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isExternalUrl('  javascript:alert(1)')).toBe(false);
    expect(isExternalUrl('JavaScript:alert(1)')).toBe(false);
  });

  it('refuses schemes outside the granted scope rather than throwing at the opener', () => {
    expect(isExternalUrl('file:///C:/secrets.txt')).toBe(false);
    expect(isExternalUrl('unityide://open?path=x')).toBe(false);
    expect(isExternalUrl('data:text/html,<script>')).toBe(false);
  });

  it('treats in-app hrefs as internal, so anchors and routes still work', () => {
    // Read from the ATTRIBUTE, never HTMLAnchorElement.href: the DOM resolves
    // `#section` against the page, which in prod is http://tauri.localhost/ —
    // an internal jump would look external and get shipped to the browser.
    expect(isExternalUrl('#section')).toBe(false);
    expect(isExternalUrl('/docs/plan.md')).toBe(false);
    expect(isExternalUrl('./relative.md')).toBe(false);
    expect(isExternalUrl('')).toBe(false);
    expect(isExternalUrl(null)).toBe(false);
  });
});

describe('externalTarget', () => {
  const click = (over: Partial<Parameters<typeof externalTarget>[0]> = {}) => ({
    defaultPrevented: false,
    button: 0,
    href: 'https://unity.com',
    hasDownload: false,
    ...over,
  });

  it('claims a plain left-click on an external link', () => {
    expect(externalTarget(click())).toBe('https://unity.com');
  });

  it('claims a middle-click too — it would otherwise navigate nowhere', () => {
    expect(externalTarget(click({ button: 1 }))).toBe('https://unity.com');
  });

  it('leaves right-click alone so the context menu still works', () => {
    expect(externalTarget(click({ button: 2 }))).toBeNull();
  });

  it('yields to a handler that already claimed the click', () => {
    expect(externalTarget(click({ defaultPrevented: true }))).toBeNull();
  });

  it('leaves a download link alone', () => {
    expect(externalTarget(click({ hasDownload: true }))).toBeNull();
  });

  it('ignores a click that was not on a link at all', () => {
    expect(externalTarget(click({ href: null }))).toBeNull();
  });
});

/**
 * Fixtures captured from the real monaco-editor 0.55.1 `URI` — the two
 * spellings it offers, for the same input. Stubbed rather than imported so the
 * suite keeps its no-DOM, no-Monaco property; the strings are ground truth.
 */
describe('browserUrlFor', () => {
  const monacoUri = (encoded: string, raw: string) => ({
    toString: (skipEncoding?: boolean) => (skipEncoding ? raw : encoded),
  });

  it('keeps a query string intact — toString() escapes = and & into one key', () => {
    const uri = monacoUri(
      'https://example.com/s?q%3Dunity%26page%3D2',
      'https://example.com/s?q=unity&page=2',
    );
    expect(browserUrlFor(uri)).toBe('https://example.com/s?q=unity&page=2');
  });

  it('re-encodes the space toString(true) decoded out of a %20', () => {
    const uri = monacoUri(
      'https://example.com/a%20b?x%3D1',
      'https://example.com/a b?x=1',
    );
    expect(browserUrlFor(uri)).toBe('https://example.com/a%20b?x=1');
  });

  it('leaves an already-clean URL alone', () => {
    const url = 'https://docs.unity3d.com/Manual/index.html';
    expect(browserUrlFor(monacoUri(url, url))).toBe(url);
  });

  it('does not disturb mailto: or tel:', () => {
    expect(browserUrlFor(monacoUri('mailto:a@b.c', 'mailto:a@b.c'))).toBe('mailto:a@b.c');
    expect(browserUrlFor(monacoUri('tel:+15551234', 'tel:+15551234'))).toBe('tel:+15551234');
  });
});

describe('the interception is installed, not just written', () => {
  it('runs in the CAPTURE phase — React listens at #root, below document', () => {
    const SRC = readFileSync(path.join(ROOT, 'utils/external-link.ts'), 'utf8');
    expect(SRC).toMatch(/addEventListener\(\s*'click',[^)]*,\s*true\s*\)/);
    expect(SRC).toMatch(/addEventListener\(\s*'auxclick',[^)]*,\s*true\s*\)/);
  });

  it('is installed for every window, before either view boots', () => {
    const MAIN = readFileSync(path.join(ROOT, 'main.tsx'), 'utf8');
    expect(MAIN).toMatch(/installExternalLinkHandler\(\)/);
  });

  it('covers Monaco links, which never touch the DOM anchor path', () => {
    const INIT = readFileSync(path.join(ROOT, 'features/editor/services/monaco-init.ts'), 'utf8');
    expect(INIT).toMatch(/registerLinkOpener/);
  });

  it('never hands Monaco\'s default URI spelling to the opener', () => {
    const INIT = readFileSync(path.join(ROOT, 'features/editor/services/monaco-init.ts'), 'utf8');
    expect(INIT).toMatch(/browserUrlFor\(resource\)/);
    expect(INIT).not.toMatch(/resource\.toString\(\s*\)/);
  });
});
