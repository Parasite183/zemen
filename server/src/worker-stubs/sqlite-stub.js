// Build-time stand-in for `better-sqlite3` (a native Node module that
// cannot run on Cloudflare Workers). wrangler.jsonc aliases the real
// package to this file for the Worker bundle. The D1 driver never
// touches it — on Workers the D1 binding replaces SQLite entirely.
export default {};
