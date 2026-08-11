import type { SchwabOptionsLadder, SchwabLadderRung } from "./schwab.functions";
import { magnetsFromRungs } from "./ladder-magnet.server";
import { splitByAggressor, sumAggressor } from "./ladder-side.server";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type CacheEntry = { value: SchwabOptionsLadder | null; at: number };

// Public feeds (CBOE / Nasdaq) are 15-min delayed, so a short cache is fine —
// this only throttles our outbound requests, not data freshness.
const FRESH_MS = 2_000;
const STALE_MS = 60_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<SchwabOptionsLadder | null>>();

const num = (v: unknown) => {
  if (v == null || v === "--" || v === "") return 0;
  const n = Number(String(v).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

async function fetchJson(url: string, init: RequestInit = {}, timeoutMs = 4500): Promise<any | null> {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...init, signal: controller.signal });
    if (!res.ok) return null;
    return await res.json().catch(() => null);
  } catch {
    return null;
  } finally {
    clearTimeout(id);
  }
}

function labelForExpiry(expiry: string) {
  const d = new Date(expiry + "T00:00:00Z");
  return Number.isNaN(d.getTime()) ? expiry : `${d.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} ${d.getUTCDate()}`;
}

// Today's date in America/New_York, formatted YYYY-MM-DD. Used to detect
// public feeds that haven't rolled to the current session yet.
function todayET(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(new Date());
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function finishLadder(args: {
  symbol: string;
  expiry: string;
  dte: number | null;
  spot: number | null;
  rungs: SchwabLadderRung[];
  alternateExpiries: { expiry: string; dte: number | null; label: string; volume?: number | null }[];
  asOf?: string | null;
}): SchwabOptionsLadder | null {
  const all = args.rungs.sort((a, b) => a.strike - b.strike);
  if (!all.length) return null;

  let callTot = 0;
  let putTot = 0;
  let callOiTot = 0;
  let putOiTot = 0;
  let magC: { strike: number; volume: number } | null = null;
  let magP: { strike: number; volume: number } | null = null;
  let oiMagC: { strike: number; volume: number } | null = null;
  let oiMagP: { strike: number; volume: number } | null = null;

  for (const r of all) {
    callTot += r.callVol;
    putTot += r.putVol;
    callOiTot += r.callOi;
    putOiTot += r.putOi;
    if (r.callVol > (magC?.volume ?? 0)) magC = { strike: r.strike, volume: r.callVol };
    if (r.putVol > (magP?.volume ?? 0)) magP = { strike: r.strike, volume: r.putVol };
    if (r.callOi > (oiMagC?.volume ?? 0)) oiMagC = { strike: r.strike, volume: r.callOi };
    if (r.putOi > (oiMagP?.volume ?? 0)) oiMagP = { strike: r.strike, volume: r.putOi };
  }

  let source: "volume" | "oi" = "volume";
  let effCallTot = callTot;
  let effPutTot = putTot;
  let effMagC = magC;
  let effMagP = magP;
  let displayRungs = all;
  if (callTot === 0 && putTot === 0) {
    source = "oi";
    effCallTot = callOiTot;
    effPutTot = putOiTot;
    effMagC = oiMagC;
    effMagP = oiMagP;
    displayRungs = all.map((r) => ({ ...r, callVol: r.callOi, putVol: r.putOi }));
  }
  if (effCallTot === 0 && effPutTot === 0) return null;

  let spot = args.spot;
  if (!spot || spot <= 0) {
    const active = effMagC && effMagP
      ? (effMagC.volume >= effMagP.volume ? effMagC.strike : effMagP.strike)
      : (effMagC?.strike ?? effMagP?.strike ?? displayRungs[Math.floor(displayRungs.length / 2)].strike);
    spot = active;
  }

  let trimmed = displayRungs;
  if (spot && spot > 0) {
    const lo = spot * 0.75;
    const hi = spot * 1.25;
    trimmed = displayRungs.filter((r) => r.strike >= lo && r.strike <= hi);
    if (trimmed.length < 8) {
      trimmed = [...displayRungs]
        .sort((a, b) => Math.abs(a.strike - spot!) - Math.abs(b.strike - spot!))
        .slice(0, 24)
        .sort((a, b) => a.strike - b.strike);
    }
  }

  // Magnet must come from the rendered near-the-money window, not the whole
  // chain — deep OTM spread legs are not price targets. Do NOT re-inject the
  // full-chain magnet strike into `trimmed`; that would let the deep-OTM leg
  // win again and make this filter a no-op.
  {
    const w = magnetsFromRungs(trimmed, "volume");
    if (w.call || w.put) { effMagC = w.call; effMagP = w.put; }
  }
  const aggressor = sumAggressor(trimmed);

  return {
    symbol: args.symbol,
    expiry: args.expiry,
    dte: args.dte,
    label: labelForExpiry(args.expiry),
    hasWeeklies: typeof args.dte === "number" && args.dte <= 10,
    spot,
    callVolume: effCallTot,
    putVolume: effPutTot,
    magnetCall: effMagC ? { strike: effMagC.strike, volume: effMagC.volume, pct: effCallTot > 0 ? effMagC.volume / effCallTot : 0 } : null,
    magnetPut: effMagP ? { strike: effMagP.strike, volume: effMagP.volume, pct: effPutTot > 0 ? effMagP.volume / effPutTot : 0 } : null,
    ...aggressor,
    ladder: trimmed,
    alternateExpiries: args.alternateExpiries,
    source,
    asOf: args.asOf ?? null,
  };
}

async function fetchCboe(symbol: string, expiryIndex: number): Promise<SchwabOptionsLadder | null> {
  const json = await fetchJson(
    `https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`,
    { headers: { "User-Agent": UA, Accept: "application/json" } },
  );
  const rows: any[] = Array.isArray(json?.data?.options) ? json.data.options : [];
  if (!rows.length) return null;

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  // Newest trade timestamp across the whole chain — used to detect
  // prior-session snapshots (CBOE's public CDN often serves yesterday's
  // data for a while after the new open).
  let newestTradeIso: string | null = null;
  const byExpiry = new Map<string, { dte: number; rungs: Map<number, SchwabLadderRung> }>();
  for (const row of rows) {
    const raw = typeof row?.option === "string" ? row.option : "";
    const m = raw.match(/^(.+?)(\d{6})([CP])(\d{8})$/);
    if (!m) continue;
    const ts = typeof row?.last_trade_time === "string" ? row.last_trade_time : "";
    if (ts && (!newestTradeIso || ts > newestTradeIso)) newestTradeIso = ts;
    const yy = Number(m[2].slice(0, 2));
    const mm = Number(m[2].slice(2, 4));
    const dd = Number(m[2].slice(4, 6));
    const year = 2000 + yy;
    const expDate = new Date(Date.UTC(year, mm - 1, dd));
    const dte = Math.round((expDate.getTime() - today.getTime()) / 86400000);
    const strike = Number(m[4]) / 1000;
    if (!Number.isFinite(dte) || dte < 0 || !Number.isFinite(strike) || strike <= 0) continue;
    const expiry = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    const bucket = byExpiry.get(expiry) ?? { dte, rungs: new Map<number, SchwabLadderRung>() };
    const rung = bucket.rungs.get(strike) ?? { strike, callVol: 0, putVol: 0, callOi: 0, putOi: 0 };
    if (m[3] === "C") {
      const v = num(row?.volume);
      const s = splitByAggressor(v, num(row?.last_trade_price), num(row?.bid), num(row?.ask));
      rung.callVol += v;
      rung.callOi += num(row?.open_interest);
      rung.callBuyVol = (rung.callBuyVol ?? 0) + s.buy;
      rung.callSellVol = (rung.callSellVol ?? 0) + s.sell;
    } else {
      const v = num(row?.volume);
      const s = splitByAggressor(v, num(row?.last_trade_price), num(row?.bid), num(row?.ask));
      rung.putVol += v;
      rung.putOi += num(row?.open_interest);
      rung.putBuyVol = (rung.putBuyVol ?? 0) + s.buy;
      rung.putSellVol = (rung.putSellVol ?? 0) + s.sell;
    }
    bucket.rungs.set(strike, rung);
    byExpiry.set(expiry, bucket);
  }

  // If the newest trade in the feed is from a prior ET session, the
  // "volume" column is yesterday's cumulative — do not present it as
  // live intraday flow. Zero the volumes so finishLadder falls back to
  // OI-based magnet (stable, meaningful) and surface asOf so the UI can
  // label the timestamp.
  const today_et = todayET();
  const staleSession = !!(newestTradeIso && newestTradeIso.slice(0, 10) < today_et);
  if (staleSession) {
    for (const bucket of byExpiry.values()) {
      for (const r of bucket.rungs.values()) {
        r.callVol = 0; r.putVol = 0;
        r.callBuyVol = 0; r.callSellVol = 0; r.putBuyVol = 0; r.putSellVol = 0;
      }
    }
  }

  const expiries = Array.from(byExpiry.entries()).sort((a, b) => a[1].dte - b[1].dte);
  if (!expiries.length) return null;
  const idx = Math.min(Math.max(0, expiryIndex), expiries.length - 1);
  const [expiry, bucket] = expiries[idx];
  return finishLadder({
    symbol,
    expiry,
    dte: bucket.dte,
    spot: Number.isFinite(json?.data?.current_price) ? Number(json.data.current_price) : null,
    rungs: Array.from(bucket.rungs.values()),
    alternateExpiries: expiries.slice(0, 12).map(([e, b]) => {
      let vol = 0;
      for (const r of b.rungs.values()) vol += r.callVol + r.putVol;
      return { expiry: e, dte: b.dte, label: labelForExpiry(e), volume: vol };
    }),
    asOf: newestTradeIso,
  });
}

async function fetchNasdaq(symbol: string, expiryIndex: number): Promise<SchwabOptionsLadder | null> {
  const json = await fetchJson(
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain` +
      `?assetclass=stocks&limit=2000&fromdate=all&todate=undefined&excode=oprac&callput=callput&money=all&type=all`,
    { headers: { "User-Agent": UA, Accept: "application/json", "Accept-Language": "en-US,en;q=0.9" } },
  );
  const rows: any[] = json?.data?.table?.rows ?? [];
  if (!rows.length) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const parseExp = (raw: string) => {
    let d: Date | null = null;
    const slash4 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
    const slash2 = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2})$/);
    const dash = raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
    const monthDay = raw.match(/^([A-Za-z]{3,9})\s+(\d{1,2})$/);
    if (slash4) d = new Date(+slash4[3], +slash4[1] - 1, +slash4[2]);
    else if (slash2) {
      const yy = +slash2[3];
      d = new Date(yy < 80 ? 2000 + yy : 1900 + yy, +slash2[1] - 1, +slash2[2]);
    } else if (dash) d = new Date(+dash[1], +dash[2] - 1, +dash[3]);
    else if (monthDay) {
      const month = new Date(`${monthDay[1]} 1, ${today.getFullYear()}`).getMonth();
      d = new Date(today.getFullYear(), month, +monthDay[2]);
      if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month, +monthDay[2]);
    } else {
      const t = Date.parse(raw);
      if (!Number.isNaN(t)) d = new Date(t);
    }
    if (!d || Number.isNaN(d.getTime())) return null;
    d.setHours(0, 0, 0, 0);
    const dte = Math.round((d.getTime() - today.getTime()) / 86400000);
    if (dte < 0) return null;
    return { expiry: `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`, dte };
  };

  const byExpiry = new Map<string, { dte: number; rungs: Map<number, SchwabLadderRung> }>();
  for (const row of rows) {
    const meta = parseExp(row?.expiryDate ? String(row.expiryDate) : "");
    const strike = num(row?.strike);
    if (!meta || strike <= 0) continue;
    const bucket = byExpiry.get(meta.expiry) ?? { dte: meta.dte, rungs: new Map<number, SchwabLadderRung>() };
    const rung = bucket.rungs.get(strike) ?? { strike, callVol: 0, putVol: 0, callOi: 0, putOi: 0 };
    const cv = num(row?.c_Volume);
    const pv = num(row?.p_Volume);
    const cs = splitByAggressor(cv, num(row?.c_Last), num(row?.c_Bid), num(row?.c_Ask));
    const ps = splitByAggressor(pv, num(row?.p_Last), num(row?.p_Bid), num(row?.p_Ask));
    rung.callVol += cv;
    rung.putVol += pv;
    rung.callBuyVol = (rung.callBuyVol ?? 0) + cs.buy;
    rung.callSellVol = (rung.callSellVol ?? 0) + cs.sell;
    rung.putBuyVol = (rung.putBuyVol ?? 0) + ps.buy;
    rung.putSellVol = (rung.putSellVol ?? 0) + ps.sell;
    rung.callOi += num(row?.c_Openinterest);
    rung.putOi += num(row?.p_Openinterest);
    bucket.rungs.set(strike, rung);
    byExpiry.set(meta.expiry, bucket);
  }

  const expiries = Array.from(byExpiry.entries()).sort((a, b) => a[1].dte - b[1].dte);
  if (!expiries.length) return null;
  const idx = Math.min(Math.max(0, expiryIndex), expiries.length - 1);
  const [expiry, bucket] = expiries[idx];
  return finishLadder({
    symbol,
    expiry,
    dte: bucket.dte,
    spot: null,
    rungs: Array.from(bucket.rungs.values()),
    alternateExpiries: expiries.slice(0, 12).map(([e, b]) => {
      let vol = 0;
      for (const r of b.rungs.values()) vol += r.callVol + r.putVol;
      return { expiry: e, dte: b.dte, label: labelForExpiry(e), volume: vol };
    }),
    asOf: null,
  });
}

function hasRealVolume(ladder: SchwabOptionsLadder | null) {
  return ladder?.source !== "oi" && ((ladder?.callVolume ?? 0) > 0 || (ladder?.putVolume ?? 0) > 0);
}

export async function fetchFastPublicOptionsLadder(symbol: string, expiryIndex = 0): Promise<SchwabOptionsLadder | null> {
  const sym = symbol.trim().toUpperCase();
  if (!/^[A-Z0-9.\-^]{1,10}$/.test(sym)) return null;
  const idx = Number.isFinite(expiryIndex) ? Math.max(0, Math.floor(expiryIndex)) : 0;
  const key = `${sym}:${idx}`;
  const now = Date.now();
  const cached = cache.get(key);
  if (cached && now - cached.at < FRESH_MS) return cached.value;
  const existing = inflight.get(key);
  if (existing) return existing;

  const promise = (async () => {
    const cboe = await fetchCboe(sym, idx);
    if (hasRealVolume(cboe)) {
      cache.set(key, { value: cboe, at: Date.now() });
      return cboe;
    }
    const nasdaq = await fetchNasdaq(sym, idx);
    const best = hasRealVolume(nasdaq) ? nasdaq : (cboe ?? nasdaq);
    if (best) {
      cache.set(key, { value: best, at: Date.now() });
      return best;
    }
    if (cached && now - cached.at < STALE_MS) return cached.value;
    cache.set(key, { value: null, at: Date.now() });
    return null;
  })().finally(() => inflight.delete(key));

  inflight.set(key, promise);
  return promise;
}