import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SchwabQuote, SchwabFundamental, SchwabTopStrikes, SchwabBar } from "./schwab.functions";

/**
 * Shared Schwab feed.
 *
 * The project owner stores their Schwab tokens in `public.schwab_owner_tokens`.
 * Any visitor (signed in or not) can call the `getShared*` functions below;
 * they use the owner's token server-side as a shared real-time feed.
 *
 * Tradeoff: this is against Schwab's ToS (account is per-user). If Schwab
 * notices and revokes, the shared feed breaks — per-user OAuth still works.
 */

const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";

type OwnerTokenRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  obtained_at: string;
};

async function loadOwnerTokenFresh(): Promise<{ accessToken: string } | null> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { data, error } = await supabaseAdmin
    .from("schwab_owner_tokens")
    .select("user_id, access_token, refresh_token, expires_at, obtained_at")
    .order("updated_at", { ascending: false })
    .limit(1)
    .maybeSingle();
  if (error) {
    console.error("[schwab-shared] load owner token", error.message);
    return null;
  }
  if (!data) return null;
  const row = data as OwnerTokenRow;
  const expiresAt = new Date(row.expires_at).getTime();
  // Refresh 60s before expiry
  if (expiresAt - Date.now() > 60_000) {
    return { accessToken: row.access_token };
  }
  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[schwab-shared] missing Schwab client credentials");
    return { accessToken: row.access_token }; // best-effort
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: row.refresh_token,
  });
  const res = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    console.error("[schwab-shared] refresh failed", res.status, (await res.text()).slice(0, 200));
    return { accessToken: row.access_token };
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
  return { accessToken: fresh.access_token };
}

async function schwabGet(path: string, accessToken: string): Promise<Response> {
  return fetch(`https://api.schwabapi.com${path}`, {
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
}

function cleanBidAsk(mark: number | null, bid: number | null, ask: number | null): { bid: number | null; ask: number | null } {
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return { bid: null, ask: null };
  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return { bid: null, ask: null };
  }
  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  if (spread > Math.max(mark * 0.03, mark < 5 ? 0.08 : 0.05)) return { bid: null, ask: null };
  if (Math.abs(mid - mark) > Math.max(mark * 0.018, mark < 5 ? 0.05 : 0.03)) return { bid: null, ask: null };
  return { bid, ask };
}

// ============ Owner: persist tokens ============
export const setOwnerSchwabTokens = createServerFn({ method: "POST" })
  .middleware([requireSupabaseAuth])
  .inputValidator((d: { accessToken: string; refreshToken: string; expiresIn: number; scope?: string; tokenType?: string }) => d)
  .handler(async ({ data, context }) => {
    const expiresAt = new Date(Date.now() + (Number(data.expiresIn) || 1800) * 1000).toISOString();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("schwab_owner_tokens")
      .upsert({
        user_id: context.userId,
        access_token: data.accessToken,
        refresh_token: data.refreshToken,
        expires_at: expiresAt,
        obtained_at: new Date().toISOString(),
        scope: data.scope ?? null,
        token_type: data.tokenType ?? null,
      }, { onConflict: "user_id" });
    if (error) throw new Error(`Failed to store Schwab tokens: ${error.message}`);
    return { ok: true };
  });

// ============ Shared quotes (public) ============
export const getSharedSchwabQuotes = createServerFn({ method: "POST" })
  .inputValidator((d: { symbols: string[] }) => d)
  .handler(async ({ data }): Promise<Record<string, SchwabQuote> | null> => {
    const syms = (data.symbols || []).map((s) => s.toUpperCase()).filter(Boolean);
    if (syms.length === 0) return {};
    const tok = await loadOwnerTokenFresh();
    if (!tok) return null;
    const res = await schwabGet(
      `/marketdata/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}&fields=quote,regular`,
      tok.accessToken,
    );
    if (!res.ok) {
      console.error("[schwab-shared] quotes", res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    const out: Record<string, SchwabQuote> = {};
    for (const sym of syms) {
      const row = json?.[sym];
      const q = row?.quote ?? {};
      const last = Number.isFinite(q.lastPrice) ? q.lastPrice : null;
      const rawBid = Number.isFinite(q.bidPrice) ? q.bidPrice : null;
      const rawAsk = Number.isFinite(q.askPrice) ? q.askPrice : null;
      const nbbo = cleanBidAsk(last, rawBid, rawAsk);
      out[sym] = {
        symbol: sym,
        last,
        bid: nbbo.bid,
        ask: nbbo.ask,
        bidSize: Number.isFinite(q.bidSize) ? q.bidSize : null,
        askSize: Number.isFinite(q.askSize) ? q.askSize : null,
        netChange: Number.isFinite(q.netChange) ? q.netChange : null,
        netPercentChange: Number.isFinite(q.netPercentChange) ? q.netPercentChange : null,
        quoteTime: Number.isFinite(q.quoteTime) ? q.quoteTime : null,
        vwap: Number.isFinite(q.vwap) ? q.vwap : null,
        totalVolume: Number.isFinite(q.totalVolume) ? q.totalVolume : null,
      };
    }
    return out;
  });

// ============ Shared fundamentals (public) ============
export const getSharedSchwabFundamentals = createServerFn({ method: "POST" })
  .inputValidator((d: { symbols: string[] }) => d)
  .handler(async ({ data }): Promise<Record<string, SchwabFundamental> | null> => {
    const syms = (data.symbols || []).map((s) => s.toUpperCase()).filter(Boolean);
    if (syms.length === 0) return {};
    const tok = await loadOwnerTokenFresh();
    if (!tok) return null;
    const res = await schwabGet(
      `/marketdata/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}&fields=fundamental`,
      tok.accessToken,
    );
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => ({}));
    const out: Record<string, SchwabFundamental> = {};
    for (const sym of syms) {
      const f = json?.[sym]?.fundamental ?? {};
      out[sym] = {
        symbol: sym,
        sharesOutstanding: Number.isFinite(f.sharesOutstanding) ? f.sharesOutstanding : null,
        shortIntToFloat: Number.isFinite(f.shortIntToFloat) ? f.shortIntToFloat : null,
        shortIntDayToCover: Number.isFinite(f.shortIntDayToCover) ? f.shortIntDayToCover : null,
        marketCap: Number.isFinite(f.marketCap) ? f.marketCap : null,
        avg10DaysVolume: Number.isFinite(f.avg10DaysVolume) ? f.avg10DaysVolume : null,
      };
    }
    return out;
  });

// ============ Shared top strikes (public) ============
export const getSharedSchwabTopStrikes = createServerFn({ method: "POST" })
  .inputValidator((d: { symbol: string }) => d)
  .handler(async ({ data }): Promise<SchwabTopStrikes | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return null;
    const tok = await loadOwnerTokenFresh();
    if (!tok) return null;
    const res = await schwabGet(
      `/marketdata/v1/chains?symbol=${encodeURIComponent(sym)}&contractType=ALL&includeQuotes=false&range=ALL&strikeCount=200`,
      tok.accessToken,
    );
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => ({}));
    const callMap = json?.callExpDateMap ?? {};
    const putMap = json?.putExpDateMap ?? {};
    const allKeys = Array.from(new Set([...Object.keys(callMap), ...Object.keys(putMap)])).sort();
    let chosen: string | null = null;
    for (const k of allKeys) {
      const [, dteStr] = k.split(":");
      const dte = Number(dteStr);
      if (!Number.isFinite(dte) || dte < 0) continue;
      chosen = k; break;
    }
    if (!chosen) return null;
    const [expiry, dteStr] = chosen.split(":");
    const dte = Number(dteStr);
    const pickTop = (map: any) => {
      const exp = map?.[chosen!] ?? {};
      let best = 0, bestStrike = 0, total = 0;
      const rows: { strike: number; volume: number }[] = [];
      for (const sk of Object.keys(exp)) {
        const arr = exp[sk];
        const v = Array.isArray(arr) && arr[0]?.totalVolume ? Number(arr[0].totalVolume) : 0;
        if (!Number.isFinite(v)) continue;
        total += v;
        if (v > 0) rows.push({ strike: Number(sk), volume: v });
        if (v > best) { best = v; bestStrike = Number(sk); }
      }
      rows.sort((a, b) => b.volume - a.volume);
      const top = rows.slice(0, 2).map((r) => ({ strike: r.strike, volume: r.volume, pct: total > 0 ? r.volume / total : 0 }));
      return { strike: bestStrike || null, pct: bestStrike && total > 0 ? best / total : null, total, top };
    };
    const tc = pickTop(callMap);
    const tp = pickTop(putMap);
    const d = new Date(expiry + "T00:00:00");
    const label = Number.isNaN(d.getTime()) ? expiry
      : `${d.toLocaleString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(-2)}`;
    const pcRatio = tc.total > 0 ? +(tp.total / tc.total).toFixed(3) : null;
    return {
      symbol: sym, expiry, dte: Number.isFinite(dte) ? dte : null, label,
      topCallStrike: tc.strike, topCallPct: tc.pct,
      topPutStrike: tp.strike, topPutPct: tp.pct,
      callVolume: tc.total, putVolume: tp.total,
      topCalls: tc.top, topPuts: tp.top, pcRatio,
    };
  });

// ============ Shared price history (public) ============
export const getSharedSchwabPriceHistory = createServerFn({ method: "POST" })
  .inputValidator((d: { symbol: string; minutes?: 1 | 5 | 10 | 15 | 30; days?: 1 | 2 | 3 | 5 | 10 }) => d)
  .handler(async ({ data }): Promise<SchwabBar[] | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return [];
    const tok = await loadOwnerTokenFresh();
    if (!tok) return null;
    const freq = data.minutes ?? 1;
    const period = data.days ?? 2;
    const res = await schwabGet(
      `/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}&periodType=day&period=${period}&frequencyType=minute&frequency=${freq}&needExtendedHoursData=true`,
      tok.accessToken,
    );
    if (!res.ok) return null;
    const json: any = await res.json().catch(() => ({}));
    const candles: any[] = Array.isArray(json?.candles) ? json.candles : [];
    return candles
      .filter((c) => Number.isFinite(c?.close))
      .map((c) => ({
        t: Math.floor(Number(c.datetime) / 1000),
        open: Number(c.open), high: Number(c.high), low: Number(c.low),
        close: Number(c.close), volume: Number(c.volume) || 0,
      }));
  });