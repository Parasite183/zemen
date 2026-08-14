// ─────────────────────────────────────────────────────────────────────
// Cloudflare Pages middleware — proxies API + upload traffic to the
// API Worker and lets everything else fall through to static assets.
//
// Why: Cloudflare Pages `_redirects` cannot proxy to *external* domains
// (only relative URLs), so /api/* and /uploads/* must be forwarded by a
// Pages Function instead. `wrangler pages deploy web/dist` picks up this
// file from web/functions (the directory next to the output dir).
//
// The Worker URL is stable once deployed (zemen-api.<account>.workers.dev);
// update it here if the Worker is ever renamed or moved accounts.
// ─────────────────────────────────────────────────────────────────────
const WORKER = 'https://zemen-api.183georgedaniel.workers.dev';

export async function onRequest({ request, next }) {
  const url = new URL(request.url);

  if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/uploads/')) {
    // Forward the request to the API Worker, preserving method, headers
    // and body. Drop content-length: the forwarded body is a stream, so
    // letting the platform set the framing avoids mismatches.
    const headers = new Headers(request.headers);
    headers.delete('content-length');
    return fetch(WORKER + url.pathname + url.search, {
      method: request.method,
      headers,
      body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    });
  }

  // Static assets (and the native SPA fallback to index.html) handle
  // everything else.
  return next();
}
