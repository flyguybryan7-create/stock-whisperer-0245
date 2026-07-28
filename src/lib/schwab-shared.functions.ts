import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";
import type { SchwabQuote, SchwabFundamental, SchwabTopStrikes, SchwabBar, SchwabOptionsLadder } from "./schwab.functions";
import { buildLadderFromChain } from "./schwab-ladder.server";
import { magnetsFromRungs } from "./ladder-magnet.server";
import { fetchFastPublicOptionsLadder } from "./options-ladder.server";

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
const NASDAQ_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type OwnerTokenRow = {
  user_id: string;
  access_token: string;
  refresh_token: string;
  expires_at: string;
  obtained_at: string;
};

function isDeadSchwabTokenMessage(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("invalid_grant") || m.includes("unsupported_token_type") || m.includes("expired or revoked") || m.includes("invalid, expired or revoked");
}

async function deleteOwnerToken(userId: string): Promise<void> {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  const { error } = await supabaseAdmin.from("schwab_owner_tokens").delete().eq("user_id", userId);
  if (error) console.error("[schwab-shared] delete dead owner token", error.message);
}

async function loadOwnerTokenFresh(): Promise<{ accessToken: string; userId: string } | null> {
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
    return { accessToken: row.access_token, userId: row.user_id };
  }
  const clientId = process.env.SCHWAB_CLIENT_ID;
  const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    console.error("[schwab-shared] missing Schwab client credentials");
    return { accessToken: row.access_token, userId: row.user_id }; // best-effort
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
    const text = await res.text();
    console.error("[schwab-shared] refresh failed", res.status, text.slice(0, 200));
    if (isDeadSchwabTokenMessage(text)) {
      await deleteOwnerToken(row.user_id);
      return null;
    }
    return { accessToken: row.access_token, userId: row.user_id };
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
  return { accessToken: fresh.access_token, userId: row.user_id };
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

// Sentinel user_id for the shared/public owner row. Written when a visitor
// completes Schwab OAuth without being signed into BryanTrade, so the shared
// feed keeps working across sessions/devices even when nobody is logged in.
const SHARED_OWNER_UUID = "00000000-0000-0000-0000-000000000001";

// Public variant of setOwnerSchwabTokens. No auth required — anyone who
// completes a Schwab OAuth handshake (which itself requires valid Schwab
// credentials + user login on Schwab's side) becomes the shared owner.
export const setSharedSchwabTokensPublic = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; refreshToken: string; expiresIn: number; scope?: string; tokenType?: string }) => d)
  .handler(async ({ data }) => {
    if (!data.accessToken || !data.refreshToken) throw new Error("Missing Schwab tokens");
    const expiresAt = new Date(Date.now() + (Number(data.expiresIn) || 1800) * 1000).toISOString();
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("schwab_owner_tokens")
      .upsert({
        user_id: SHARED_OWNER_UUID,
        access_token: data.accessToken,
        refresh_token: data.refreshToken,
        expires_at: expiresAt,
        obtained_at: new Date().toISOString(),
        scope: data.scope ?? null,
        token_type: data.tokenType ?? null,
      }, { onConflict: "user_id" });
    if (error) throw new Error(`Failed to store shared Schwab tokens: ${error.message}`);
    return { ok: true };
  });

// ============ Shared token presence check (public) ============
// Any origin (preview or published) can call this to know whether a shared
// Schwab owner token is stored server-side. Used by the UI to show a
// "Schwab connected" state even when the current tab's localStorage is empty
// — e.g. after OAuth redirected the user through a different origin.
export const hasSharedSchwabToken = createServerFn({ method: "GET" }).handler(async () => {
  try {
    const tok = await loadOwnerTokenFresh();
    if (!tok) return { present: false as const };
    return { present: true as const };
  } catch (e) {
    console.error("[schwab-shared] hasSharedSchwabToken", e);
    return { present: false as const };
  }
});

// Public disconnect: wipes ALL stored Schwab owner tokens (shared + any
// per-user rows) so a subsequent "Connect Schwab" starts a fresh OAuth flow.
// No auth required — matches setSharedSchwabTokensPublic's trust model.
export const disconnectSharedSchwabPublic = createServerFn({ method: "POST" }).handler(async () => {
  try {
    const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
    const { error } = await supabaseAdmin
      .from("schwab_owner_tokens")
      .delete()
      .not("user_id", "is", null);
    if (error) throw new Error(error.message);
    return { ok: true as const };
  } catch (e) {
    console.error("[schwab-shared] disconnectSharedSchwabPublic", e);
    throw e;
  }
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
      if (res.status === 401 || res.status === 403) await deleteOwnerToken(tok.userId);
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
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) await deleteOwnerToken(tok.userId);
      return null;
    }
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
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) await deleteOwnerToken(tok.userId);
      return null;
    }
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
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) await deleteOwnerToken(tok.userId);
      return null;
    }
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

// ============ Shared options ladder (public) ============
export const getSharedSchwabOptionsLadder = createServerFn({ method: "POST" })
  .inputValidator((d: { symbol: string; expiryIndex?: number }) => d)
  .handler(async ({ data }): Promise<SchwabOptionsLadder | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return null;
    const tok = await loadOwnerTokenFresh();
    if (!tok) return null;
    const res = await schwabGet(
      `/marketdata/v1/chains?symbol=${encodeURIComponent(sym)}&contractType=ALL&includeQuotes=false&range=ALL&strikeCount=200`,
      tok.accessToken,
    );
    if (!res.ok) {
      if (res.status === 401 || res.status === 403) await deleteOwnerToken(tok.userId);
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    return buildLadderFromChain(sym, json, data.expiryIndex ?? 0, "shared");
  });

// Fast public ladder for the Options Flow Magnet. It uses a short server-side
// cache and races through public providers without requiring Schwab OAuth, so
// opening/reloading the terminal does not leave the magnet blank or hammer CBOE.
export const getFastOptionsLadder = createServerFn({ method: "POST" })
  .inputValidator((d: { symbol: string; expiryIndex?: number }) => d)
  .handler(async ({ data }): Promise<SchwabOptionsLadder | null> => {
    return fetchFastPublicOptionsLadder(data.symbol || "", data.expiryIndex ?? 0);
  });

// ============ Polygon-backed options ladder (public, no OAuth) ============
// Free of Schwab OAuth so the Options Flow Magnet works even when nobody has
// completed the Schwab handshake. Uses POLYGON_API_KEY server-side.
export const getPolygonOptionsLadder = createServerFn({ method: "POST" })
  .inputValidator((d: { symbol: string; expiryIndex?: number }) => d)
  .handler(async ({ data }): Promise<SchwabOptionsLadder | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return null;
    const key = process.env.POLYGON_API_KEY;
    if (!key) return null;

    type PolyContract = {
      details?: { strike_price?: number; contract_type?: "call" | "put"; expiration_date?: string };
      day?: { volume?: number };
      open_interest?: number;
      underlying_asset?: { price?: number };
    };
    const contracts: PolyContract[] = [];
    let spot: number | null = null;
    let url: string | null =
      `https://api.polygon.io/v3/snapshot/options/${encodeURIComponent(sym)}?limit=250&apiKey=${key}`;
    // Pull up to 3 pages (750 contracts) so we cover full chain for liquid names.
    for (let page = 0; page < 3 && url; page++) {
      const res = await fetch(url);
      if (!res.ok) {
        console.error("[polygon] options snapshot", sym, res.status, (await res.text()).slice(0, 200));
        if (page === 0) return null;
        break;
      }
      const json: any = await res.json().catch(() => ({}));
      const rows: PolyContract[] = Array.isArray(json?.results) ? json.results : [];
      for (const r of rows) {
        if (spot == null && Number.isFinite(r?.underlying_asset?.price)) {
          spot = Number(r.underlying_asset!.price);
        }
        contracts.push(r);
      }
      url = typeof json?.next_url === "string" ? `${json.next_url}&apiKey=${key}` : null;
    }
    if (contracts.length === 0) return null;

    // Pick nearest non-past expiry.
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const expiries = Array.from(
      new Set(
        contracts
          .map((c) => c.details?.expiration_date)
          .filter((e): e is string => typeof e === "string" && /^\d{4}-\d{2}-\d{2}$/.test(e)),
      ),
    ).sort();
    const futureExpiries = expiries
      .filter((e) => new Date(e + "T00:00:00Z").getTime() >= today.getTime())
      .sort();
    if (!futureExpiries.length) return null;
    const pIdx = Math.min(Math.max(0, data.expiryIndex ?? 0), futureExpiries.length - 1);
    const nearest = futureExpiries[pIdx];
    const dte = Math.round((new Date(nearest + "T00:00:00Z").getTime() - today.getTime()) / 86400000);
    const alternateExpiries = futureExpiries.slice(0, 8).map((e) => {
      const dObj = new Date(e + "T00:00:00Z");
      const d = Math.round((dObj.getTime() - today.getTime()) / 86400000);
      let vol = 0;
      for (const c of contracts) {
        if (c.details?.expiration_date !== e) continue;
        const v = Number(c.day?.volume ?? 0) || 0;
        if (Number.isFinite(v)) vol += v;
      }
      return {
        expiry: e,
        dte: Number.isFinite(d) ? d : null,
        label: Number.isNaN(dObj.getTime()) ? e : `${dObj.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${dObj.getUTCDate()}`,
        volume: vol,
      };
    });

    // Aggregate ladder for that expiry. Polygon sometimes returns open
    // interest before day-volume fields are populated; keep OI around as a
    // fallback so the magnet still renders instead of showing an empty card.
    type Rung = { strike: number; callVol: number; putVol: number; callOi: number; putOi: number };
    const byStrike = new Map<number, Rung>();
    let callTot = 0, putTot = 0;
    let magC: { strike: number; volume: number } | null = null;
    let magP: { strike: number; volume: number } | null = null;
    let callOiTot = 0, putOiTot = 0;
    let oiMagC: { strike: number; volume: number } | null = null;
    let oiMagP: { strike: number; volume: number } | null = null;
    for (const c of contracts) {
      const d = c.details;
      if (!d || d.expiration_date !== nearest) continue;
      const strike = Number(d.strike_price);
      if (!Number.isFinite(strike)) continue;
      const v = Number(c.day?.volume ?? 0) || 0;
      const oi = Number(c.open_interest ?? 0) || 0;
      let rung = byStrike.get(strike);
      if (!rung) { rung = { strike, callVol: 0, putVol: 0, callOi: 0, putOi: 0 }; byStrike.set(strike, rung); }
      if (d.contract_type === "call") {
        rung.callVol += v; rung.callOi += oi; callTot += v; callOiTot += oi;
        if (v > (magC?.volume ?? 0)) magC = { strike, volume: v };
        if (oi > (oiMagC?.volume ?? 0)) oiMagC = { strike, volume: oi };
      } else if (d.contract_type === "put") {
        rung.putVol += v; rung.putOi += oi; putTot += v; putOiTot += oi;
        if (v > (magP?.volume ?? 0)) magP = { strike, volume: v };
        if (oi > (oiMagP?.volume ?? 0)) oiMagP = { strike, volume: oi };
      }
    }
    // Prefer intraday volume, but fall back to OI so illiquid tickers and
    // pre-market still render. The ladder is tagged source="oi" so the
    // client merge prefers any volume-based provider first.
    let source: "volume" | "oi" = "volume";
    let effCallTot = callTot, effPutTot = putTot;
    let effMagC = magC, effMagP = magP;
    if (callTot === 0 && putTot === 0) {
      source = "oi";
      effCallTot = callOiTot; effPutTot = putOiTot;
      effMagC = oiMagC; effMagP = oiMagP;
      if (effCallTot === 0 && effPutTot === 0) return null;
    }
    const all = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
    let trimmed = all;
    if (spot && spot > 0) {
      const lo = spot * 0.75, hi = spot * 1.25;
      trimmed = all.filter((r) => r.strike >= lo && r.strike <= hi);
      if (trimmed.length < 8) {
        trimmed = [...all]
          .sort((a, b) => Math.abs(a.strike - spot!) - Math.abs(b.strike - spot!))
          .slice(0, 20)
          .sort((a, b) => a.strike - b.strike);
      }
    }
    // Magnet comes from the rendered near-the-money window only.
    {
      const w = magnetsFromRungs(trimmed, source);
      if (w.call || w.put) { effMagC = w.call; effMagP = w.put; }
    }
    const dObj = new Date(nearest + "T00:00:00");
    const label = Number.isNaN(dObj.getTime()) ? nearest
      : `${dObj.toLocaleString("en-US", { month: "short" })} ${dObj.getDate()}`;
    return {
      symbol: sym,
      expiry: nearest,
      dte: Number.isFinite(dte) ? dte : null,
      label,
      hasWeeklies: Number.isFinite(dte) && dte <= 10,
      spot,
      callVolume: effCallTot,
      putVolume: effPutTot,
      magnetCall: effMagC ? { strike: effMagC.strike, volume: effMagC.volume, pct: effCallTot > 0 ? effMagC.volume / effCallTot : 0 } : null,
      magnetPut: effMagP ? { strike: effMagP.strike, volume: effMagP.volume, pct: effPutTot > 0 ? effMagP.volume / effPutTot : 0 } : null,
      ladder: trimmed,
      alternateExpiries,
      source,
    };
  });

// ============ Cboe delayed options ladder (public, no OAuth) ============
// Reliable no-login fallback for the Options Flow Magnet. It provides the full
// listed chain plus volume/open interest, so the chart can render even when the
// shared Schwab token is absent and Polygon has no snapshot entitlement.
export const getCboeOptionsLadder = createServerFn({ method: "POST" })
  .inputValidator((d: { symbol: string; expiryIndex?: number }) => d)
  .handler(async ({ data }): Promise<SchwabOptionsLadder | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return null;
    const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(sym)}.json`, {
      headers: { "User-Agent": NASDAQ_UA, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("[cboe-ladder] status", sym, res.status);
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    const options: any[] = Array.isArray(json?.data?.options) ? json.data.options : [];
    if (!options.length) return null;
    const spot = Number.isFinite(json?.data?.current_price) ? Number(json.data.current_price) : null;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    type Parsed = { expiry: string; dte: number; type: "call" | "put"; strike: number; volume: number; oi: number };
    const parsed: Parsed[] = [];
    for (const row of options) {
      const raw = typeof row?.option === "string" ? row.option : "";
      const m = raw.match(/^(.+?)(\d{6})([CP])(\d{8})$/);
      if (!m) continue;
      const yy = Number(m[2].slice(0, 2));
      const mm = Number(m[2].slice(2, 4));
      const dd = Number(m[2].slice(4, 6));
      const year = 2000 + yy;
      const expDate = new Date(Date.UTC(year, mm - 1, dd));
      if (Number.isNaN(expDate.getTime())) continue;
      const dte = Math.round((expDate.getTime() - today.getTime()) / 86400000);
      if (dte < 0) continue;
      const strike = Number(m[4]) / 1000;
      if (!Number.isFinite(strike) || strike <= 0) continue;
      const volume = Number(row?.volume ?? 0) || 0;
      const oi = Number(row?.open_interest ?? 0) || 0;
      if (volume <= 0 && oi <= 0) continue;
      parsed.push({
        expiry: `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`,
        dte,
        type: m[3] === "C" ? "call" : "put",
        strike,
        volume,
        oi,
      });
    }
    if (!parsed.length) return null;
    const expiries = Array.from(new Set(parsed.map((p) => p.expiry))).sort();
    const cIdx = Math.min(Math.max(0, data.expiryIndex ?? 0), expiries.length - 1);
    const nearest = expiries[cIdx];
    const chosenRows = parsed.filter((p) => p.expiry === nearest);
    const dte = chosenRows[0]?.dte ?? null;
    const alternateExpiries = expiries.slice(0, 8).map((e) => {
      const dObj = new Date(e + "T00:00:00");
      const rows = parsed.filter((p) => p.expiry === e);
      const vol = rows.reduce((s, r) => s + (Number.isFinite(r.volume) ? r.volume : 0), 0);
      return {
        expiry: e,
        dte: rows[0]?.dte ?? null,
        label: Number.isNaN(dObj.getTime()) ? e : `${dObj.toLocaleString("en-US", { month: "short" })} ${dObj.getDate()}`,
        volume: vol,
      };
    });
    type Rung = { strike: number; callVol: number; putVol: number; callOi: number; putOi: number };
    const byStrike = new Map<number, Rung>();
    let callTot = 0, putTot = 0, callOiTot = 0, putOiTot = 0;
    let magC: { strike: number; volume: number } | null = null;
    let magP: { strike: number; volume: number } | null = null;
    let oiMagC: { strike: number; volume: number } | null = null;
    let oiMagP: { strike: number; volume: number } | null = null;
    for (const opt of chosenRows) {
      let rung = byStrike.get(opt.strike);
      if (!rung) { rung = { strike: opt.strike, callVol: 0, putVol: 0, callOi: 0, putOi: 0 }; byStrike.set(opt.strike, rung); }
      if (opt.type === "call") {
        rung.callVol += opt.volume; rung.callOi += opt.oi; callTot += opt.volume; callOiTot += opt.oi;
        if (opt.volume > (magC?.volume ?? 0)) magC = { strike: opt.strike, volume: opt.volume };
        if (opt.oi > (oiMagC?.volume ?? 0)) oiMagC = { strike: opt.strike, volume: opt.oi };
      } else {
        rung.putVol += opt.volume; rung.putOi += opt.oi; putTot += opt.volume; putOiTot += opt.oi;
        if (opt.volume > (magP?.volume ?? 0)) magP = { strike: opt.strike, volume: opt.volume };
        if (opt.oi > (oiMagP?.volume ?? 0)) oiMagP = { strike: opt.strike, volume: opt.oi };
      }
    }
    // Prefer intraday volume; fall back to OI so illiquid tickers still render.
    let source: "volume" | "oi" = "volume";
    let effCallTot = callTot, effPutTot = putTot;
    let effMagC = magC, effMagP = magP;
    if (callTot === 0 && putTot === 0) {
      source = "oi";
      effCallTot = callOiTot; effPutTot = putOiTot;
      effMagC = oiMagC; effMagP = oiMagP;
      if (effCallTot === 0 && effPutTot === 0) return null;
    }
    const all = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
    if (!all.length) return null;
    let trimmed = all;
    if (spot && spot > 0) {
      const lo = spot * 0.75, hi = spot * 1.25;
      trimmed = all.filter((r) => r.strike >= lo && r.strike <= hi);
      if (trimmed.length < 8) {
        trimmed = [...all]
          .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
          .slice(0, 20)
          .sort((a, b) => a.strike - b.strike);
      }
    }
    // Magnet comes from the rendered near-the-money window only.
    {
      const w = magnetsFromRungs(trimmed, source);
      if (w.call || w.put) { effMagC = w.call; effMagP = w.put; }
    }
    const dObj = new Date(nearest + "T00:00:00");
    const label = Number.isNaN(dObj.getTime()) ? nearest
      : `${dObj.toLocaleString("en-US", { month: "short" })} ${dObj.getDate()}`;
    return {
      symbol: sym,
      expiry: nearest,
      dte,
      label,
      hasWeeklies: typeof dte === "number" && dte <= 10,
      spot,
      callVolume: effCallTot,
      putVolume: effPutTot,
      magnetCall: effMagC ? { strike: effMagC.strike, volume: effMagC.volume, pct: effCallTot > 0 ? effMagC.volume / effCallTot : 0 } : null,
      magnetPut: effMagP ? { strike: effMagP.strike, volume: effMagP.volume, pct: effPutTot > 0 ? effMagP.volume / effPutTot : 0 } : null,
      ladder: trimmed,
      alternateExpiries,
      source,
    };
  });

// ============ Nasdaq public options ladder (no OAuth/no API key) ============
// Last-resort fallback for the Options Flow Magnet. Nasdaq's public chain often
// exposes open interest even when same-day volume is blank/pre-market; use OI as
// a readable proxy so the chart still shows where strikes are concentrated.
export const getNasdaqOptionsLadder = createServerFn({ method: "POST" })
  .inputValidator((d: { symbol: string; spot?: number | null; expiryIndex?: number }) => d)
  .handler(async ({ data }): Promise<SchwabOptionsLadder | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return null;
    const url =
      `https://api.nasdaq.com/api/quote/${encodeURIComponent(sym)}/option-chain` +
      `?assetclass=stocks&limit=2000&fromdate=all&todate=undefined` +
      `&excode=oprac&callput=callput&money=all&type=all`;
    const res = await fetch(url, {
      headers: {
        "User-Agent": NASDAQ_UA,
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!res.ok) {
      console.error("[nasdaq-ladder] status", sym, res.status);
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    const rows: any[] = json?.data?.table?.rows ?? [];
    if (!rows.length) return null;

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const num = (v: any) => {
      if (v == null || v === "--" || v === "") return 0;
      const n = Number(String(v).replace(/[$,%\s,]/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    const parseExp = (s: string): { time: number; dte: number; expiry: string; label: string } | null => {
      let d: Date | null = null;
      const slash4 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const slash2 = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
      const dash = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
      const monthDay = s.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
      if (slash4) d = new Date(+slash4[3], +slash4[1] - 1, +slash4[2]);
      else if (slash2) {
        const yy = +slash2[3];
        d = new Date(yy < 80 ? 2000 + yy : 1900 + yy, +slash2[1] - 1, +slash2[2]);
      } else if (dash) d = new Date(+dash[1], +dash[2] - 1, +dash[3]);
      else if (monthDay) {
        const month = new Date(`${monthDay[1]} 1, ${today.getFullYear()}`).getMonth();
        if (Number.isFinite(month)) {
          d = new Date(today.getFullYear(), month, +monthDay[2]);
          if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month, +monthDay[2]);
        }
      } else {
        const t = Date.parse(s);
        if (!Number.isNaN(t)) d = new Date(t);
      }
      if (!d || Number.isNaN(d.getTime())) return null;
      d.setHours(0, 0, 0, 0);
      const dte = Math.round((d.getTime() - today.getTime()) / 86400000);
      if (dte < 0) return null;
      const yyyy = d.getFullYear();
      const mm = String(d.getMonth() + 1).padStart(2, "0");
      const dd = String(d.getDate()).padStart(2, "0");
      return {
        time: d.getTime(),
        dte,
        expiry: `${yyyy}-${mm}-${dd}`,
        label: `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`,
      };
    };

    type RawBucket = { meta: NonNullable<ReturnType<typeof parseExp>>; rows: any[]; activity: number };
    const buckets = new Map<string, RawBucket>();
    for (const row of rows) {
      const expRaw = row?.expiryDate ? String(row.expiryDate) : "";
      const meta = parseExp(expRaw);
      const strike = num(row?.strike);
      if (!meta || strike <= 0) continue;
      const activity = num(row?.c_Volume) + num(row?.p_Volume) + num(row?.c_Openinterest) + num(row?.p_Openinterest);
      if (activity <= 0) continue;
      const existing = buckets.get(meta.expiry) ?? { meta, rows: [], activity: 0 };
      existing.rows.push(row);
      existing.activity += activity;
      buckets.set(meta.expiry, existing);
    }
    const sortedBuckets = Array.from(buckets.values()).sort((a, b) => a.meta.dte - b.meta.dte);
    if (!sortedBuckets.length) return null;
    const nIdx = Math.min(Math.max(0, data.expiryIndex ?? 0), sortedBuckets.length - 1);
    const chosen = sortedBuckets[nIdx];
    const alternateExpiries = sortedBuckets.slice(0, 8).map((b) => {
      let vol = 0;
      for (const r of b.rows) vol += num(r?.c_Volume) + num(r?.p_Volume);
      return {
        expiry: b.meta.expiry,
        dte: b.meta.dte,
        label: b.meta.label,
        volume: vol,
      };
    });

    type Rung = { strike: number; callVol: number; putVol: number; callOi: number; putOi: number };
    const byStrike = new Map<number, Rung>();
    let callTot = 0, putTot = 0;
    let magC: { strike: number; volume: number } | null = null;
    let magP: { strike: number; volume: number } | null = null;
    let callOiTot = 0, putOiTot = 0;
    let oiMagC: { strike: number; volume: number } | null = null;
    let oiMagP: { strike: number; volume: number } | null = null;
    for (const row of chosen.rows) {
      const strike = num(row?.strike);
      if (strike <= 0) continue;
      // Real intraday volume only. Do NOT fall back to open interest per
      // side — mixing real call volume with put OI (or vice versa) produces
      // magnet strikes that reverse every refresh as new prints arrive.
      const callVol = num(row?.c_Volume);
      const putVol = num(row?.p_Volume);
      const callOi = num(row?.c_Openinterest);
      const putOi = num(row?.p_Openinterest);
      let rung = byStrike.get(strike);
      if (!rung) { rung = { strike, callVol: 0, putVol: 0, callOi: 0, putOi: 0 }; byStrike.set(strike, rung); }
      rung.callVol += callVol; rung.putVol += putVol; rung.callOi += callOi; rung.putOi += putOi;
      callTot += callVol; putTot += putVol;
      callOiTot += callOi; putOiTot += putOi;
      if (callVol > (magC?.volume ?? 0)) magC = { strike, volume: callVol };
      if (putVol > (magP?.volume ?? 0)) magP = { strike, volume: putVol };
      if (callOi > (oiMagC?.volume ?? 0)) oiMagC = { strike, volume: callOi };
      if (putOi > (oiMagP?.volume ?? 0)) oiMagP = { strike, volume: putOi };
    }
    // Prefer intraday volume; fall back to OI when nothing has traded yet.
    let source: "volume" | "oi" = "volume";
    let effCallTot = callTot, effPutTot = putTot;
    let effMagC = magC, effMagP = magP;
    if (callTot === 0 && putTot === 0) {
      source = "oi";
      effCallTot = callOiTot; effPutTot = putOiTot;
      effMagC = oiMagC; effMagP = oiMagP;
    }
    const all = Array.from(byStrike.values()).sort((a, b) => a.strike - b.strike);
    if (!all.length || (effCallTot === 0 && effPutTot === 0)) return null;
    let spot = typeof data.spot === "number" && Number.isFinite(data.spot) && data.spot > 0 ? data.spot : null;
    if (!spot) {
      const active = effMagC && effMagP ? (effMagC.volume >= effMagP.volume ? effMagC.strike : effMagP.strike) : (effMagC?.strike ?? effMagP?.strike ?? all[Math.floor(all.length / 2)].strike);
      spot = active;
    }
    let trimmed = all;
    if (spot && spot > 0) {
      const lo = spot * 0.75, hi = spot * 1.25;
      trimmed = all.filter((r) => r.strike >= lo && r.strike <= hi);
      if (trimmed.length < 8) {
        trimmed = [...all]
          .sort((a, b) => Math.abs(a.strike - spot!) - Math.abs(b.strike - spot!))
          .slice(0, 20)
          .sort((a, b) => a.strike - b.strike);
      }
    }
    // Magnet comes from the rendered near-the-money window only.
    {
      const w = magnetsFromRungs(trimmed, source);
      if (w.call || w.put) { effMagC = w.call; effMagP = w.put; }
    }
    return {
      symbol: sym,
      expiry: chosen.meta.expiry,
      dte: chosen.meta.dte,
      label: chosen.meta.label,
      hasWeeklies: chosen.meta.dte <= 10,
      spot,
      callVolume: effCallTot,
      putVolume: effPutTot,
      magnetCall: effMagC ? { strike: effMagC.strike, volume: effMagC.volume, pct: effCallTot > 0 ? effMagC.volume / effCallTot : 0 } : null,
      magnetPut: effMagP ? { strike: effMagP.strike, volume: effMagP.volume, pct: effPutTot > 0 ? effMagP.volume / effPutTot : 0 } : null,
      ladder: trimmed,
      alternateExpiries,
      source,
    };
  });