import { createServerFn } from "@tanstack/react-start";
import { setCookie, getCookie, deleteCookie } from "@tanstack/react-start/server";

/**
 * Schwab OAuth helpers.
 * Requires SCHWAB_CLIENT_ID and SCHWAB_CLIENT_SECRET as runtime secrets.
 * Callback URL registered with Schwab must match the one passed in here exactly.
 */

const AUTHORIZE_URL = "https://api.schwabapi.com/v1/oauth/authorize";
const TOKEN_URL = "https://api.schwabapi.com/v1/oauth/token";
const STATE_COOKIE = "schwab_oauth_state";

export type SchwabTokens = {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  token_type: string;
  scope?: string;
  obtained_at: number;
};

export const getSchwabAuthUrl = createServerFn({ method: "POST" })
  .inputValidator((d: { redirectUri: string }) => d)
  .handler(async ({ data }) => {
    const clientId = process.env.SCHWAB_CLIENT_ID;
    if (!clientId) throw new Error("SCHWAB_CLIENT_ID is not configured");
    const state = crypto.randomUUID();
    setCookie(STATE_COOKIE, state, {
      httpOnly: true,
      secure: true,
      sameSite: "lax",
      path: "/",
      maxAge: 60 * 10,
    });
    const url = new URL(AUTHORIZE_URL);
    url.searchParams.set("client_id", clientId);
    url.searchParams.set("redirect_uri", data.redirectUri);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("state", state);
    return { url: url.toString() };
  });

export const exchangeSchwabCode = createServerFn({ method: "POST" })
  .inputValidator((d: { code: string; redirectUri: string; state: string }) => d)
  .handler(async ({ data }): Promise<SchwabTokens> => {
    const expected = getCookie(STATE_COOKIE);
    if (!expected || !data.state || expected !== data.state) {
      throw new Error("Invalid OAuth state — possible CSRF. Please retry sign-in.");
    }
    deleteCookie(STATE_COOKIE, { path: "/" });
    const clientId = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("Schwab credentials not configured");

    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "authorization_code",
      code: data.code,
      redirect_uri: data.redirectUri,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Schwab token exchange failed (${res.status}): ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    return { ...json, obtained_at: Date.now() };
  });

export type SchwabQuote = {
  symbol: string;
  last: number | null;
  bid: number | null;
  ask: number | null;
  bidSize: number | null;
  askSize: number | null;
  netChange: number | null;
  netPercentChange: number | null;
  quoteTime: number | null; // ms epoch
  vwap: number | null;
  totalVolume: number | null;
};

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

export const getSchwabQuotes = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; symbols: string[] }) => d)
  .handler(async ({ data }): Promise<Record<string, SchwabQuote>> => {
    const syms = (data.symbols || []).map((s) => s.toUpperCase()).filter(Boolean);
    if (syms.length === 0) return {};
    const url = `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}&fields=quote,regular`;
    const res = await fetch(url, {
      headers: {
        Authorization: `Bearer ${data.accessToken}`,
        Accept: "application/json",
      },
    });
    const text = await res.text();
    if (res.status === 401) throw new Error("schwab_unauthorized");
    if (!res.ok) throw new Error(`Schwab quotes failed (${res.status}): ${text.slice(0, 300)}`);
    let json: any;
    try { json = JSON.parse(text); } catch { throw new Error("Schwab returned non-JSON quotes"); }
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

export const refreshSchwabToken = createServerFn({ method: "POST" })
  .inputValidator((d: { refreshToken: string }) => d)
  .handler(async ({ data }): Promise<SchwabTokens> => {
    const clientId = process.env.SCHWAB_CLIENT_ID;
    const clientSecret = process.env.SCHWAB_CLIENT_SECRET;
    if (!clientId || !clientSecret) throw new Error("Schwab credentials not configured");
    const basic = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");
    const body = new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: data.refreshToken,
    });
    const res = await fetch(TOKEN_URL, {
      method: "POST",
      headers: {
        Authorization: `Basic ${basic}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: body.toString(),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`Schwab token refresh failed (${res.status}): ${text.slice(0, 300)}`);
    const json = JSON.parse(text);
    return { ...json, obtained_at: Date.now() };
  });

// ============ Schwab 24-hour intraday price history ============
// Returns minute candles for the last 2 calendar days with extended hours so
// the chart can render a true 24h tape for overnight-tradeable equities.
export type SchwabBar = {
  t: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export const getSchwabPriceHistory = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; symbol: string; minutes?: 1 | 5 | 10 | 15 | 30; days?: 1 | 2 | 3 | 5 | 10 }) => d)
  .handler(async ({ data }): Promise<SchwabBar[]> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return [];
    const freq = data.minutes ?? 1;
    const period = data.days ?? 2;
    const url =
      `https://api.schwabapi.com/marketdata/v1/pricehistory?symbol=${encodeURIComponent(sym)}` +
      `&periodType=day&period=${period}&frequencyType=minute&frequency=${freq}&needExtendedHoursData=true`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${data.accessToken}`, Accept: "application/json" },
    });
    if (res.status === 401) throw new Error("schwab_unauthorized");
    if (!res.ok) {
      console.error("[schwab] pricehistory", sym, res.status, (await res.text()).slice(0, 200));
      return [];
    }
    const json: any = await res.json().catch(() => ({}));
    const candles: any[] = Array.isArray(json?.candles) ? json.candles : [];
    return candles
      .filter((c) => Number.isFinite(c?.close))
      .map((c) => ({
        t: Math.floor(Number(c.datetime) / 1000),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume) || 0,
      }));
  });

// ============ Schwab fundamentals (short interest / float) ============
export type SchwabFundamental = {
  symbol: string;
  sharesOutstanding: number | null;
  shortIntToFloat: number | null;   // already a percentage (e.g. 18.32)
  shortIntDayToCover: number | null;
  marketCap: number | null;
  avg10DaysVolume: number | null;
};

export const getSchwabFundamentals = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; symbols: string[] }) => d)
  .handler(async ({ data }): Promise<Record<string, SchwabFundamental>> => {
    const syms = (data.symbols || []).map((s) => s.toUpperCase()).filter(Boolean);
    if (syms.length === 0) return {};
    const url = `https://api.schwabapi.com/marketdata/v1/quotes?symbols=${encodeURIComponent(syms.join(","))}&fields=fundamental`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${data.accessToken}`, Accept: "application/json" },
    });
    if (res.status === 401) throw new Error("schwab_unauthorized");
    if (!res.ok) {
      console.error("[schwab] fundamentals", res.status, (await res.text()).slice(0, 200));
      return {};
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

// ============ Schwab options chain — top-volume strike per side ============
export type SchwabTopStrikes = {
  symbol: string;
  expiry: string | null;            // YYYY-MM-DD
  dte: number | null;
  label: string | null;             // e.g. "Jun '26"
  topCallStrike: number | null;
  topCallPct: number | null;        // 0..1 share of side's volume at strike
  topPutStrike: number | null;
  topPutPct: number | null;
  callVolume: number;
  putVolume: number;
  topCalls: { strike: number; pct: number; volume: number }[]; // top 2, share of call volume
  topPuts: { strike: number; pct: number; volume: number }[];
  pcRatio: number | null;           // put volume / call volume (all-strike, chosen expiry)
};

export const getSchwabTopStrikes = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; symbol: string }) => d)
  .handler(async ({ data }): Promise<SchwabTopStrikes | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return null;
    const url =
      `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(sym)}` +
      `&contractType=ALL&includeQuotes=false&range=ALL&strikeCount=200`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${data.accessToken}`, Accept: "application/json" },
    });
    if (res.status === 401) throw new Error("schwab_unauthorized");
    if (!res.ok) {
      console.error("[schwab] chains", sym, res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    const callMap = json?.callExpDateMap ?? {};
    const putMap = json?.putExpDateMap ?? {};
    // Keys look like "2026-06-19:21" (expiry:DTE). Pick the smallest non-negative DTE
    // that has any volume on either side.
    const allKeys = Array.from(new Set([...Object.keys(callMap), ...Object.keys(putMap)])).sort();
    let chosen: string | null = null;
    for (const k of allKeys) {
      const [, dteStr] = k.split(":");
      const dte = Number(dteStr);
      if (!Number.isFinite(dte) || dte < 0) continue;
      chosen = k;
      break;
    }
    if (!chosen) return null;
    const [expiry, dteStr] = chosen.split(":");
    const dte = Number(dteStr);
    const pickTopFromExp = (map: any): { strike: number | null; pct: number | null; total: number; top: { strike: number; pct: number; volume: number }[] } => {
      const exp = map?.[chosen!] ?? {};
      let best = 0, bestStrike = 0, total = 0;
      const rows: { strike: number; volume: number }[] = [];
      for (const strikeKey of Object.keys(exp)) {
        const arr = exp[strikeKey];
        const v = Array.isArray(arr) && arr[0]?.totalVolume ? Number(arr[0].totalVolume) : 0;
        if (!Number.isFinite(v)) continue;
        total += v;
        if (v > 0) rows.push({ strike: Number(strikeKey), volume: v });
        if (v > best) { best = v; bestStrike = Number(strikeKey); }
      }
      rows.sort((a, b) => b.volume - a.volume);
      const top = rows.slice(0, 2).map((r) => ({
        strike: r.strike, volume: r.volume, pct: total > 0 ? r.volume / total : 0,
      }));
      return { strike: bestStrike || null, pct: bestStrike && total > 0 ? best / total : null, total, top };
    };
    const tc = pickTopFromExp(callMap);
    const tp = pickTopFromExp(putMap);
    const d = new Date(expiry + "T00:00:00");
    const label = Number.isNaN(d.getTime())
      ? expiry
      : `${d.toLocaleString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(-2)}`;
    const pcRatio = tc.total > 0 ? +(tp.total / tc.total).toFixed(3) : null;
    return {
      symbol: sym,
      expiry,
      dte: Number.isFinite(dte) ? dte : null,
      label,
      topCallStrike: tc.strike,
      topCallPct: tc.pct,
      topPutStrike: tp.strike,
      topPutPct: tp.pct,
      callVolume: tc.total,
      putVolume: tp.total,
      topCalls: tc.top,
      topPuts: tp.top,
      pcRatio,
    };
  });

// ============ Schwab options ladder — full strike-by-strike flow ============
// Powers the Options-Flow day-trader chart. Returns the whole strike ladder
// (call/put volume + OI) for the nearest weekly expiry so the UI can render
// a magnet map of where premium is flowing.
export type SchwabLadderRung = {
  strike: number;
  callVol: number;
  putVol: number;
  callOi: number;
  putOi: number;
};
export type SchwabOptionsLadder = {
  symbol: string;
  expiry: string | null;      // YYYY-MM-DD
  dte: number | null;
  label: string | null;
  hasWeeklies: boolean;       // true when nearest expiry is ≤ 10 DTE
  spot: number | null;        // underlying last price (from chain payload)
  callVolume: number;         // totals across the chosen expiry
  putVolume: number;
  magnetCall: { strike: number; pct: number; volume: number } | null;
  magnetPut: { strike: number; pct: number; volume: number } | null;
  ladder: SchwabLadderRung[]; // sorted ascending by strike, trimmed near spot
};

function buildLadderFromChain(sym: string, json: any): SchwabOptionsLadder | null {
  const callMap = json?.callExpDateMap ?? {};
  const putMap = json?.putExpDateMap ?? {};
  const spot = Number.isFinite(json?.underlyingPrice) ? Number(json.underlyingPrice) : null;
  const allKeys = Array.from(new Set([...Object.keys(callMap), ...Object.keys(putMap)])).sort();
  let chosen: string | null = null;
  for (const k of allKeys) {
    const dte = Number(k.split(":")[1]);
    if (!Number.isFinite(dte) || dte < 0) continue;
    chosen = k; break;
  }
  if (!chosen) return null;
  const [expiry, dteStr] = chosen.split(":");
  const dte = Number(dteStr);
  const cExp = callMap?.[chosen] ?? {};
  const pExp = putMap?.[chosen] ?? {};
  const strikes = new Set<number>();
  for (const k of Object.keys(cExp)) strikes.add(Number(k));
  for (const k of Object.keys(pExp)) strikes.add(Number(k));
  const rungs: SchwabLadderRung[] = [];
  let callTot = 0, putTot = 0;
  let magC: { strike: number; volume: number } | null = null;
  let magP: { strike: number; volume: number } | null = null;
  for (const strike of Array.from(strikes).sort((a, b) => a - b)) {
    const c = cExp[strike];
    const p = pExp[strike];
    const cv = Array.isArray(c) && c[0]?.totalVolume ? Number(c[0].totalVolume) : 0;
    const pv = Array.isArray(p) && p[0]?.totalVolume ? Number(p[0].totalVolume) : 0;
    const coi = Array.isArray(c) && c[0]?.openInterest ? Number(c[0].openInterest) : 0;
    const poi = Array.isArray(p) && p[0]?.openInterest ? Number(p[0].openInterest) : 0;
    callTot += cv; putTot += pv;
    if (cv > (magC?.volume ?? 0)) magC = { strike, volume: cv };
    if (pv > (magP?.volume ?? 0)) magP = { strike, volume: pv };
    rungs.push({ strike, callVol: cv, putVol: pv, callOi: coi, putOi: poi });
  }
  // Trim to ±25% around spot (or ±20 strikes) so the chart isn't dominated
  // by dead LEAP-style tails.
  let trimmed = rungs;
  if (spot && spot > 0) {
    const lo = spot * 0.75, hi = spot * 1.25;
    trimmed = rungs.filter((r) => r.strike >= lo && r.strike <= hi);
    if (trimmed.length < 8) {
      // fallback: 20 strikes closest to spot
      trimmed = [...rungs]
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
        .slice(0, 20)
        .sort((a, b) => a.strike - b.strike);
    }
  }
  const d = new Date(expiry + "T00:00:00");
  const label = Number.isNaN(d.getTime()) ? expiry
    : `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
  return {
    symbol: sym,
    expiry,
    dte: Number.isFinite(dte) ? dte : null,
    label,
    hasWeeklies: Number.isFinite(dte) && dte <= 10,
    spot,
    callVolume: callTot,
    putVolume: putTot,
    magnetCall: magC ? { strike: magC.strike, volume: magC.volume, pct: callTot > 0 ? magC.volume / callTot : 0 } : null,
    magnetPut: magP ? { strike: magP.strike, volume: magP.volume, pct: putTot > 0 ? magP.volume / putTot : 0 } : null,
    ladder: trimmed,
  };
}

export const getSchwabOptionsLadder = createServerFn({ method: "POST" })
  .inputValidator((d: { accessToken: string; symbol: string }) => d)
  .handler(async ({ data }): Promise<SchwabOptionsLadder | null> => {
    const sym = (data.symbol || "").toUpperCase();
    if (!sym) return null;
    const url =
      `https://api.schwabapi.com/marketdata/v1/chains?symbol=${encodeURIComponent(sym)}` +
      `&contractType=ALL&includeQuotes=false&range=ALL&strikeCount=200`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${data.accessToken}`, Accept: "application/json" },
    });
    if (res.status === 401) throw new Error("schwab_unauthorized");
    if (!res.ok) {
      console.error("[schwab] ladder", sym, res.status, (await res.text()).slice(0, 200));
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    return buildLadderFromChain(sym, json);
  });

export { buildLadderFromChain as _buildLadderFromChain };