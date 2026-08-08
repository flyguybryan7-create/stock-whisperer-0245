/**
 * Shared HTTP client for Schwab market-data calls.
 *
 * Two problems this solves:
 * 1. Cloudflare Workers' fetch sends no `User-Agent`, and Schwab's Akamai edge
 *    answers those requests with an HTML "Access Denied" 403 instead of a JSON
 *    auth error. Always send a real UA + explicit Accept headers.
 * 2. Once the edge starts denying, hammering it every ~1.5s keeps the block
 *    alive. Apply a short global cooldown after a 403 so we back off instead of
 *    retrying in a tight loop.
 *
 * Server-only.
 */

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const COOLDOWN_MS = 20_000;
let blockedUntil = 0;

export function schwabEdgeBlocked(): boolean {
  return Date.now() < blockedUntil;
}

function deniedResponse(): Response {
  return new Response("schwab_edge_blocked", { status: 403 });
}

/** GET a Schwab market-data URL (absolute) with anti-block headers + backoff. */
export async function schwabApiFetch(url: string, accessToken: string): Promise<Response> {
  if (schwabEdgeBlocked()) return deniedResponse();
  const res = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
      "User-Agent": UA,
      "Accept-Language": "en-US,en;q=0.9",
    },
  });
  if (res.status === 403) blockedUntil = Date.now() + COOLDOWN_MS;
  else if (res.ok) blockedUntil = 0;
  return res;
}
