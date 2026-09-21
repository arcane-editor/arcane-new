/**
 * Cloudflare Pages advanced mode. Keep the asset service's status/cache behavior;
 * apply host rules at request time so even a preview of a live build is noindex.
 * https://developers.cloudflare.com/pages/functions/advanced-mode/
 */
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const isPublic = url.hostname === 'unityide.app' || url.hostname === 'www.unityide.app';
    const isDownload = url.pathname === '/download' || url.pathname === '/download/';
    if (url.hostname === 'www.unityide.app' || isDownload || (isPublic && url.protocol !== 'https:')) {
      if (isPublic) { url.hostname = 'unityide.app'; url.protocol = 'https:'; }
      if (isDownload) { url.pathname = '/'; url.hash = 'download'; }
      // Explicit construction allows staging redirects to retain crawler control.
      const headers = new Headers({ Location: url.href });
      if (!isPublic) headers.set('X-Robots-Tag', 'noindex');
      return new Response(null, { status: 301, headers });
    }
    const response = await env.ASSETS.fetch(request);
    if (isPublic) return response;
    const headers = new Headers(response.headers);
    headers.set('X-Robots-Tag', 'noindex');
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  },
};
