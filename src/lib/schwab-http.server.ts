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

const BASE_COOLDOWN_MS = 20_000;
const MAX_COOLDOWN_MS = 5 * 60_000;
let blockedUntil = 0;
let consecutiveBlocks = 0;

/** Coalesce identical in-flight GETs so parallel pollers hit the edge once. */
const inflight = new Map<string, Promise<Response>>();

export function schwabEdgeBlocked(): boolean {
  return Date.now() < blockedUntil;
}

function deniedResponse(): Response {
  return new Response("schwab_edge_blocked", { status: 403 });
}

/** GET a Schwab market-data URL (absolute) with anti-block headers + backoff. */
export async function schwabApiFetch(url: string, accessToken: string): Promise<Response> {
  if (schwabEdgeBlocked()) return deniedResponse();
  const existing = inflight.get(url);
  if (existing) return (await existing).clone();
  const p = (async () => {
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: "application/json",
        "User-Agent": UA,
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (res.status === 403 || res.status === 429) {
      // Escalate the backoff each time the edge keeps denying us; a flat 20s
      // retry loop is what keeps an Akamai block alive.
      consecutiveBlocks = Math.min(consecutiveBlocks + 1, 5);
      const wait = Math.min(BASE_COOLDOWN_MS * 2 ** (consecutiveBlocks - 1), MAX_COOLDOWN_MS);
      blockedUntil = Date.now() + wait;
    } else if (res.ok) {
      consecutiveBlocks = 0;
      blockedUntil = 0;
    }
    return res;
  })();
  inflight.set(url, p);
  try {
    const res = await p;
    return res.clone();
  } finally {
    inflight.delete(url);
  }
}
