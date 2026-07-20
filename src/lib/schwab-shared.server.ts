import { SCHWAB_TOKEN_URL } from "./schwab-oauth.server";

type OwnerTokenRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  obtained_at: string;
};

/**
 * Load the current shared Schwab owner access token, refreshing if it's
 * within 60s of expiry. Returns null when no owner has connected yet or
 * the refresh fails and we have nothing usable.
 *
 * Server-only. Safe to import from other `.server.ts` files.
 */
export async function loadOwnerAccessTokenFresh(): Promise<string | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("schwab_owner_tokens")
    .select("user_id, access_token, refresh_token, expires_at, obtained_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[schwab-shared.server] load owner token", error.message);
    return null;
  }
  if (!data) return null;
  const row = data as OwnerTokenRow;
  const expiresAt = new Date(row.expires_at).getTime();
  if (expiresAt - Date.now() > 60_000) return row.access_token;
  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) return row.access_token;
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
  });
  const res = await fetch(SCHWAB_TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    console.error("[schwab-shared.server] refresh failed", res.status);
    return row.access_token;
  }
  const fresh: any = await res.json();
  const newExpiresAt = new Date(Date.now() + (Number(fresh.expires_in) || 1800) * 1000).toISOString();
  await supabaseAdmin
    .from("schwab_owner_tokens")
    .update({
      access_token: fresh.access_token,
      refresh_token: fresh.refresh_token ?? row.refresh_token,
      expires_at: newExpiresAt,
      obtained_at: new Date().toISOString(),
    })
    .eq("user_id", row.user_id);
  return fresh.access_token as string;
}

/**
 * Fetch a single Schwab quote (last + prevClose) using the shared owner token.
 * Returns null when no shared token is available or the request fails.
 *
 * `symbol` uses Schwab's format — indices are `$SOX.X`, `$SPX.X`, etc.
 */
export async function fetchSchwabSharedQuote(
  symbol: string,
): Promise<{ price: number | null; prev: number | null } | null> {
  const token = await loadOwnerAccessTokenFresh();
  if (!token) return null;
  try {
    const url = `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(symbol)}&fields=quote,regular`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("[schwab-shared.server] quote", symbol, res.status);
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    const row = json?.[symbol] ?? Object.values(json ?? {})[0];
    const q = (row as any)?.quote ?? {};
    const reg = (row as any)?.regular ?? {};
    const last = Number.isFinite(q.lastPrice)
      ? Number(q.lastPrice)
      : Number.isFinite(reg.regularMarketLastPrice)
        ? Number(reg.regularMarketLastPrice)
        : null;
    const prev = Number.isFinite(q.closePrice)
      ? Number(q.closePrice)
      : Number.isFinite(reg.regularMarketPreviousClose)
        ? Number(reg.regularMarketPreviousClose)
        : null;
    return { price: last, prev };
  } catch (err) {
    console.error("[schwab-shared.server] quote error", symbol, err);
    return null;
  }
}