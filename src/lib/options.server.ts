const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

type ParsedOption = {
  expiry: string;
  dte: number | null;
  label: string;
  type: "call" | "put";
  strike: number;
  volume: number;
  oi: number;
};

export type OptionsActivity = {
  symbol: string;
  callVolume: number;
  putVolume: number;
  callOi: number;
  putOi: number;
  pcRatio: number | null; // put/call volume
  bias: "BULL" | "BEAR" | "NEUTRAL";
  unusual: boolean; // total vol >= 1.5x total OI (heavy fresh flow)
  intensity: number; // 0..1 — used for flash strength
  expiry: string | null;
  // Highest-volume strike on each side (CBOE-listed via Nasdaq feed) +
  // share of that side's volume targeting that strike. Lets the UI show
  // e.g. "C $320 · 70%" meaning 70% of today's call volume is at $320.
  topCallStrike: number | null;
  topCallPct: number | null;
  topPutStrike: number | null;
  topPutPct: number | null;
  // Per-expiry breakdown so the UI can let the user pick the timeframe.
  // expiries[0] is the nearest expiry (lowest DTE).
  expiries: ExpiryBucket[];
};

export type ExpiryBucket = {
  expiry: string;          // YYYY-MM-DD (or original string from feed)
  dte: number | null;      // calendar days to expiry
  label: string;           // friendly label, e.g. "Jan '27"
  callVolume: number;
  putVolume: number;
  topCallStrike: number | null;
  topCallPct: number | null;
  topPutStrike: number | null;
  topPutPct: number | null;
};

export type OptionsActivityResponse = {
  items: Record<string, OptionsActivity>;
  asOf: number;
  error?: string;
};

const num = (v: any) => {
  if (v == null || v === "--" || v === "") return 0;
  const n = Number(String(v).replace(/[$,%\s,]/g, ""));
  return Number.isFinite(n) ? n : 0;
};

function parseExpiry(raw: string): { dte: number | null; label: string; time: number | null; expiry: string } {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const MS_DAY = 86400000;
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
    if (Number.isFinite(month)) {
      d = new Date(today.getFullYear(), month, +monthDay[2]);
      if (d.getTime() < today.getTime()) d = new Date(today.getFullYear() + 1, month, +monthDay[2]);
    }
  } else {
    const t = Date.parse(raw);
    if (!Number.isNaN(t)) d = new Date(t);
  }
  if (!d || Number.isNaN(d.getTime())) return { dte: null, label: raw, time: null, expiry: raw };
  d.setHours(0, 0, 0, 0);
  const dte = Math.round((d.getTime() - today.getTime()) / MS_DAY);
  const month = d.toLocaleString("en-US", { month: "short" });
  const yr = String(d.getFullYear()).slice(-2);
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return { dte, label: `${month} '${yr}`, time: d.getTime(), expiry: `${yyyy}-${mm}-${dd}` };
}

function buildActivity(symbol: string, options: ParsedOption[]): OptionsActivity | null {
  const valid = options.filter((o) => o.strike > 0 && (o.volume > 0 || o.oi > 0));
  if (!valid.length) return null;

  let callVolume = 0, putVolume = 0, callOi = 0, putOi = 0;
  const callByStrike = new Map<number, number>();
  const putByStrike = new Map<number, number>();
  type Bucket = {
    expiry: string;
    dte: number | null;
    label: string;
    time: number | null;
    callVol: number;
    putVol: number;
    callByStrike: Map<number, number>;
    putByStrike: Map<number, number>;
  };
  const byExpiry = new Map<string, Bucket>();

  for (const opt of valid) {
    if (opt.type === "call") {
      callVolume += opt.volume;
      callOi += opt.oi;
      if (opt.volume > 0) callByStrike.set(opt.strike, (callByStrike.get(opt.strike) ?? 0) + opt.volume);
    } else {
      putVolume += opt.volume;
      putOi += opt.oi;
      if (opt.volume > 0) putByStrike.set(opt.strike, (putByStrike.get(opt.strike) ?? 0) + opt.volume);
    }
    let bucket = byExpiry.get(opt.expiry);
    if (!bucket) {
      bucket = {
        expiry: opt.expiry,
        dte: opt.dte,
        label: opt.label,
        time: opt.dte == null ? null : Date.now() + opt.dte * 86400000,
        callVol: 0,
        putVol: 0,
        callByStrike: new Map(),
        putByStrike: new Map(),
      };
      byExpiry.set(opt.expiry, bucket);
    }
    if (opt.type === "call") {
      bucket.callVol += opt.volume;
      if (opt.volume > 0) bucket.callByStrike.set(opt.strike, (bucket.callByStrike.get(opt.strike) ?? 0) + opt.volume);
    } else {
      bucket.putVol += opt.volume;
      if (opt.volume > 0) bucket.putByStrike.set(opt.strike, (bucket.putByStrike.get(opt.strike) ?? 0) + opt.volume);
    }
  }

  // When markets have not printed same-day volume yet, use open interest as a
  // stable proxy so users still get a directional P/C ratio instead of blanks.
  if (callVolume === 0 && putVolume === 0 && (callOi > 0 || putOi > 0)) {
    callVolume = callOi;
    putVolume = putOi;
    callByStrike.clear();
    putByStrike.clear();
    byExpiry.clear();
    for (const opt of valid) {
      const proxy = opt.oi;
      if (opt.type === "call" && proxy > 0) callByStrike.set(opt.strike, (callByStrike.get(opt.strike) ?? 0) + proxy);
      if (opt.type === "put" && proxy > 0) putByStrike.set(opt.strike, (putByStrike.get(opt.strike) ?? 0) + proxy);
      let bucket = byExpiry.get(opt.expiry);
      if (!bucket) {
        bucket = { expiry: opt.expiry, dte: opt.dte, label: opt.label, time: opt.dte == null ? null : Date.now() + opt.dte * 86400000, callVol: 0, putVol: 0, callByStrike: new Map(), putByStrike: new Map() };
        byExpiry.set(opt.expiry, bucket);
      }
      if (opt.type === "call") {
        bucket.callVol += proxy;
        if (proxy > 0) bucket.callByStrike.set(opt.strike, (bucket.callByStrike.get(opt.strike) ?? 0) + proxy);
      } else {
        bucket.putVol += proxy;
        if (proxy > 0) bucket.putByStrike.set(opt.strike, (bucket.putByStrike.get(opt.strike) ?? 0) + proxy);
      }
    }
  }

  if (callVolume === 0 && putVolume === 0) return null;
  const pickTop = (m: Map<number, number>, total: number) => {
    if (total <= 0 || m.size === 0) return { strike: null as number | null, pct: null as number | null };
    let bestStrike = 0;
    let bestVol = 0;
    for (const [k, v] of m) if (v > bestVol) { bestVol = v; bestStrike = k; }
    return { strike: bestStrike || null, pct: bestStrike ? bestVol / total : null };
  };
  const topCall = pickTop(callByStrike, callVolume);
  const topPut = pickTop(putByStrike, putVolume);
  const expiries: ExpiryBucket[] = Array.from(byExpiry.values())
    .map((b) => {
      const tc = pickTop(b.callByStrike, b.callVol);
      const tp = pickTop(b.putByStrike, b.putVol);
      return {
        expiry: b.expiry,
        dte: b.dte,
        label: b.label,
        callVolume: b.callVol,
        putVolume: b.putVol,
        topCallStrike: tc.strike,
        topCallPct: tc.pct,
        topPutStrike: tp.strike,
        topPutPct: tp.pct,
      };
    })
    .filter((e) => e.callVolume + e.putVolume > 0 && e.dte != null && e.dte >= 0 && e.dte <= 366)
    .sort((a, b) => (a.dte ?? 1e9) - (b.dte ?? 1e9));
  const totalVol = callVolume + putVolume;
  const totalOi = callOi + putOi;
  const pcRatio = callVolume > 0 ? putVolume / callVolume : null;
  let bias: OptionsActivity["bias"] = "NEUTRAL";
  if (callVolume > 50 && callVolume >= putVolume * 1.25) bias = "BULL";
  else if (putVolume > 50 && putVolume >= callVolume * 1.25) bias = "BEAR";
  const flowRatio = totalOi > 0 ? totalVol / totalOi : 0;
  const unusual = totalVol >= 300 && flowRatio >= 0.5;
  const intensity = totalVol > 0 ? Math.min(1, Math.abs(callVolume - putVolume) / totalVol) : 0;

  return {
    symbol,
    callVolume,
    putVolume,
    callOi,
    putOi,
    pcRatio,
    bias,
    unusual,
    intensity,
    expiry: expiries[0]?.expiry ?? null,
    topCallStrike: topCall.strike,
    topCallPct: topCall.pct,
    topPutStrike: topPut.strike,
    topPutPct: topPut.pct,
    expiries,
  };
}

async function fetchCboeChain(symbol: string): Promise<OptionsActivity | null> {
  try {
    const res = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${encodeURIComponent(symbol)}.json`, {
      headers: { "User-Agent": UA, Accept: "application/json" },
    });
    if (!res.ok) {
      console.error("[options] cboe status", symbol, res.status);
      return null;
    }
    const json: any = await res.json().catch(() => ({}));
    const rows: any[] = Array.isArray(json?.data?.options) ? json.data.options : [];
    if (!rows.length) return null;
    const today = new Date();
    today.setUTCHours(0, 0, 0, 0);
    const parsed: ParsedOption[] = [];
    for (const row of rows) {
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
      if (dte < 0 || dte > 366) continue;
      const strike = Number(m[4]) / 1000;
      if (!Number.isFinite(strike) || strike <= 0) continue;
      const expiry = `${year}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
      parsed.push({
        expiry,
        dte,
        label: `${expDate.toLocaleString("en-US", { month: "short", timeZone: "UTC" })} '${String(year).slice(-2)}`,
        type: m[3] === "C" ? "call" : "put",
        strike,
        volume: num(row?.volume),
        oi: num(row?.open_interest),
      });
    }
    return buildActivity(symbol, parsed);
  } catch (e) {
    console.error("[options] cboe error", symbol, e);
    return null;
  }
}

async function fetchChain(symbol: string): Promise<OptionsActivity | null> {
  const cboe = await fetchCboeChain(symbol);
  if (cboe?.pcRatio != null) return cboe;

  // Nasdaq's public option-chain endpoint — no auth, no crumb (Yahoo's
  // /v7/finance/options now requires a crumb cookie and returns Unauthorized).
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain` +
    `?assetclass=stocks&limit=2000&fromdate=all&todate=undefined` +
    `&excode=oprac&callput=callput&money=all&type=all`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) {
      console.error("[options] nasdaq status", symbol, r.status);
      return null;
    }
    const json: any = await r.json();
    const rows: any[] = json?.data?.table?.rows ?? [];
    if (!rows.length) return null;
    const parsed: ParsedOption[] = [];
    for (const row of rows) {
      const cv = num(row?.c_Volume);
      const pv = num(row?.p_Volume);
      const strike = num(row?.strike);
      const exp = row?.expiryDate ? String(row.expiryDate) : null;
      if (exp && strike > 0) {
        const parsedExpiry = parseExpiry(exp);
        if (parsedExpiry.dte != null && parsedExpiry.dte >= 0 && parsedExpiry.dte <= 366) {
          parsed.push({ expiry: parsedExpiry.expiry, dte: parsedExpiry.dte, label: parsedExpiry.label, type: "call", strike, volume: cv, oi: num(row?.c_Openinterest) });
          parsed.push({ expiry: parsedExpiry.expiry, dte: parsedExpiry.dte, label: parsedExpiry.label, type: "put", strike, volume: pv, oi: num(row?.p_Openinterest) });
        }
      }
    }
    return buildActivity(symbol, parsed);
  } catch (e) {
    console.error("[options] error", symbol, e);
    return null;
  }
}

export async function fetchOptionsActivitySnapshot(
  symbols: string[],
): Promise<OptionsActivityResponse> {
  try {
    const list = symbols.slice(0, 20);
    const results: Array<OptionsActivity | null> = [];
    for (const symbol of list) {
      results.push(await fetchChain(symbol));
      // Public options feeds rate-limit bursts. Keep requests paced so a full
      // watchlist gets usable P/C ratios instead of a wall of 429/empty data.
      if (list.length > 1) await new Promise((resolve) => setTimeout(resolve, 150));
    }
    const items: Record<string, OptionsActivity> = {};
    results.forEach((r, i) => {
      if (r) items[list[i]] = r;
    });
    return { items, asOf: Date.now() };
  } catch (error) {
    console.error("[options] snapshot failed", error);
    return { items: {}, asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
}