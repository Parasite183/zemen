// Build-time stand-in for `pg` so the Cloudflare Worker bundle never
// includes the Postgres driver (D1 is used instead on Workers).
export default {};
