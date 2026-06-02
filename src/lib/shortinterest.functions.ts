import { createServerFn } from "@tanstack/react-start";

export type ShortInterest = {
  symbol: string;
  floatShares: number | null;
  sharesOutstanding: number | null;
  sharesShort: number | null;
  shortPercentOfFloat: number | null; // as percent (e.g. 18.3)
  shortPercentOfShares: number | null;
  shortRatio: number | null; // days to cover
  shortDate: number | null; // unix seconds
  risk: "LOW" | "MODERATE" | "HIGH" | "EXTREME" | "UNKNOWN";
};

function classify(pctFloat: number | null): ShortInterest["risk"] {
  if (pctFloat == null) return "UNKNOWN";
  if (pctFloat >= 30) return "EXTREME";
  if (pctFloat >= 20) return "HIGH";
  if (pctFloat >= 10) return "MODERATE";
  return "LOW";
}

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";

function parseNum(s: string | number | null | undefined): number | null {
  if (s == null) return null;
  if (typeof s === "number") return Number.isFinite(s) ? s : null;
  const cleaned = s.replace(/[,$\s]/g, "");
  const m = cleaned.match(/^(-?\d+(?:\.\d+)?)([KMBT])?$/i);
  if (m) {
    const n = parseFloat(m[1]);
    const mult = m[2] ? ({ K: 1e3, M: 1e6, B: 1e9, T: 1e12 } as Record<string, number>)[m[2].toUpperCase()] : 1;
    return Number.isFinite(n) ? n * mult : null;
  }
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// FINRA-sourced short interest via Nasdaq.com public API
async function fetchNasdaqShort(symbol: string): Promise<{ sharesShort: number | null; daysToCover: number | null; settlement: number | null }> {
  try {
    const url = `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/short-interest?assetclass=stocks`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) return { sharesShort: null, daysToCover: null, settlement: null };
    const json = (await res.json()) as {
      data?: { shortInterestTable?: { rows?: Array<{ settlementDate?: string; interest?: string; daysToCover?: number | string }> } };
    };
    const row = json.data?.shortInterestTable?.rows?.[0];
    if (!row) return { sharesShort: null, daysToCover: null, settlement: null };
    const settlement = row.settlementDate ? Math.floor(new Date(row.settlementDate).getTime() / 1000) : null;
    return {
      sharesShort: parseNum(row.interest ?? null),
      daysToCover: typeof row.daysToCover === "number" ? row.daysToCover : parseNum(row.daysToCover ?? null),
      settlement,
    };
  } catch {
    return { sharesShort: null, daysToCover: null, settlement: null };
  }
}

// Float + shares outstanding via stockanalysis.com public API
async function fetchFloat(symbol: string): Promise<{ float: number | null; sharesOut: number | null }> {
  try {
    const url = `https://stockanalysis.com/api/symbol/s/${encodeURIComponent(symbol.toLowerCase())}/statistics`;
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" } });
    if (!res.ok) return { float: null, sharesOut: null };
    const json = (await res.json()) as {
      data?: { shares?: { data?: Array<{ id?: string; value?: string; hover?: string }> } };
    };
    const rows = json.data?.shares?.data ?? [];
    const findVal = (id: string) => {
      const r = rows.find((x) => x.id === id);
      return r ? parseNum(r.hover ?? r.value ?? null) : null;
    };
    return { float: findVal("float"), sharesOut: findVal("sharesout") };
  } catch {
    return { float: null, sharesOut: null };
  }
}

async function fetchOne(symbol: string): Promise<ShortInterest> {
  const empty: ShortInterest = {
    symbol,
    floatShares: null,
    sharesOutstanding: null,
    sharesShort: null,
    shortPercentOfFloat: null,
    shortPercentOfShares: null,
    shortRatio: null,
    shortDate: null,
    risk: "UNKNOWN",
  };
  const [si, f] = await Promise.all([fetchNasdaqShort(symbol), fetchFloat(symbol)]);
  if (si.sharesShort == null && f.float == null) return empty;
  const pctFloat = si.sharesShort != null && f.float ? (si.sharesShort / f.float) * 100 : null;
  const pctShares = si.sharesShort != null && f.sharesOut ? (si.sharesShort / f.sharesOut) * 100 : null;
  return {
    symbol,
    floatShares: f.float,
    sharesOutstanding: f.sharesOut,
    sharesShort: si.sharesShort,
    shortPercentOfFloat: pctFloat,
    shortPercentOfShares: pctShares,
    shortRatio: si.daysToCover,
    shortDate: si.settlement,
    risk: classify(pctFloat ?? pctShares),
  };
}

export const getShortInterest = createServerFn({ method: "POST" })
  .inputValidator((input: { symbols: string[] }) => {
    if (!input || !Array.isArray(input.symbols)) throw new Error("symbols required");
    const symbols = input.symbols
      .filter((s) => typeof s === "string" && /^[A-Z.\-]{1,10}$/i.test(s))
      .slice(0, 50);
    return { symbols };
  })
  .handler(async ({ data }): Promise<Record<string, ShortInterest>> => {
    const entries = await Promise.all(data.symbols.map((s) => fetchOne(s)));
    const out: Record<string, ShortInterest> = {};
    for (const e of entries) out[e.symbol] = e;
    return out;
  });