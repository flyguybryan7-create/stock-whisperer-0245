import { createServerFn } from "@tanstack/react-start";

type YahooChart = {
  chart: {
    result?: Array<{
      meta: { regularMarketPrice: number; previousClose: number; symbol: string };
      timestamp: number[];
      indicators: {
        quote: Array<{
          open: (number | null)[];
          high: (number | null)[];
          low: (number | null)[];
          close: (number | null)[];
          volume: (number | null)[];
        }>;
      };
    }>;
    error?: { description?: string } | null;
  };
};

export type Candle = {
  date: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

async function fetchOne(symbol: string): Promise<Candle[]> {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=6mo`;
  const res = await fetch(url, {
    headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" },
  });
  if (!res.ok) throw new Error(`Yahoo ${symbol} ${res.status}`);
  const json = (await res.json()) as YahooChart;
  const r = json.chart.result?.[0];
  if (!r) return [];
  const q = r.indicators.quote[0];
  const out: Candle[] = [];
  for (let i = 0; i < r.timestamp.length; i++) {
    const c = q.close[i];
    if (c == null) continue;
    const d = new Date(r.timestamp[i] * 1000);
    out.push({
      date: d.toLocaleDateString("en-US", { month: "short", day: "numeric" }),
      open: q.open[i] ?? c,
      high: q.high[i] ?? c,
      low: q.low[i] ?? c,
      close: c,
      volume: q.volume[i] ?? 0,
    });
  }
  return out;
}

export const getQuotes = createServerFn({ method: "POST" })
  .inputValidator((input: { symbols: string[] }) => {
    if (!input || !Array.isArray(input.symbols)) throw new Error("symbols required");
    const symbols = input.symbols
      .filter((s) => typeof s === "string" && /^[A-Z.\-]{1,10}$/i.test(s))
      .slice(0, 50);
    return { symbols };
  })
  .handler(async ({ data }) => {
    const entries = await Promise.all(
      data.symbols.map(async (s) => {
        try {
          return [s, await fetchOne(s)] as const;
        } catch {
          return [s, [] as Candle[]] as const;
        }
      })
    );
    const result: Record<string, Candle[]> = {};
    for (const [s, c] of entries) result[s] = c;
    return result;
  });

export type SymbolSearchResult = {
  symbol: string;
  name: string;
  exchange: string;
  type: string;
};

export const searchSymbols = createServerFn({ method: "POST" })
  .inputValidator((input: { query: string }) => {
    const query = String(input?.query ?? "").trim().slice(0, 50);
    return { query };
  })
  .handler(async ({ data }): Promise<SymbolSearchResult[]> => {
    if (!data.query) return [];
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(data.query)}&quotesCount=10&newsCount=0`;
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      quotes?: Array<{
        symbol?: string;
        shortname?: string;
        longname?: string;
        exchDisp?: string;
        quoteType?: string;
        isYahooFinance?: boolean;
      }>;
    };
    return (json.quotes ?? [])
      .filter((q) => q.isYahooFinance && q.symbol && (q.quoteType === "EQUITY" || q.quoteType === "ETF"))
      .map((q) => ({
        symbol: q.symbol!,
        name: q.longname || q.shortname || q.symbol!,
        exchange: q.exchDisp || "",
        type: q.quoteType || "",
      }));
  });