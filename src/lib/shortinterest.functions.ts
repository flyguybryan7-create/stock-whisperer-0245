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
  try {
    const url = `https://query2.finance.yahoo.com/v10/finance/quoteSummary/${encodeURIComponent(
      symbol
    )}?modules=defaultKeyStatistics`;
    const res = await fetch(url, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36",
        Accept: "application/json",
      },
    });
    if (!res.ok) return empty;
    const json = (await res.json()) as {
      quoteSummary?: {
        result?: Array<{
          defaultKeyStatistics?: {
            floatShares?: { raw?: number };
            sharesOutstanding?: { raw?: number };
            sharesShort?: { raw?: number };
            shortRatio?: { raw?: number };
            shortPercentOfFloat?: { raw?: number };
            sharesPercentSharesOut?: { raw?: number };
            dateShortInterest?: { raw?: number };
          };
        }>;
      };
    };
    const k = json.quoteSummary?.result?.[0]?.defaultKeyStatistics;
    if (!k) return empty;
    const pctFloat =
      k.shortPercentOfFloat?.raw != null ? k.shortPercentOfFloat.raw * 100 : null;
    const pctShares =
      k.sharesPercentSharesOut?.raw != null ? k.sharesPercentSharesOut.raw * 100 : null;
    return {
      symbol,
      floatShares: k.floatShares?.raw ?? null,
      sharesOutstanding: k.sharesOutstanding?.raw ?? null,
      sharesShort: k.sharesShort?.raw ?? null,
      shortPercentOfFloat: pctFloat,
      shortPercentOfShares: pctShares,
      shortRatio: k.shortRatio?.raw ?? null,
      shortDate: k.dateShortInterest?.raw ?? null,
      risk: classify(pctFloat),
    };
  } catch {
    return empty;
  }
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