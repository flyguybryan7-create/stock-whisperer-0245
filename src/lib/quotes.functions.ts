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

// ============ Live (intraday) batch quote ============
export type LiveQuote = {
  symbol: string;
  price: number;
  change: number;
  changePercent: number;
  previousClose: number;
  marketState?: string;
};

export const getLiveQuotes = createServerFn({ method: "POST" })
  .inputValidator((input: { symbols: string[] }) => {
    if (!input || !Array.isArray(input.symbols)) throw new Error("symbols required");
    const symbols = input.symbols
      .filter((s) => typeof s === "string" && /^[A-Z.\-]{1,10}$/i.test(s))
      .slice(0, 50);
    return { symbols };
  })
  .handler(async ({ data }): Promise<Record<string, LiveQuote>> => {
    if (data.symbols.length === 0) return {};
    const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(data.symbols.join(","))}`;
    try {
      const res = await fetch(url, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" },
      });
      if (!res.ok) return {};
      const json = (await res.json()) as {
        quoteResponse?: {
          result?: Array<{
            symbol: string;
            regularMarketPrice?: number;
            regularMarketChange?: number;
            regularMarketChangePercent?: number;
            regularMarketPreviousClose?: number;
            marketState?: string;
          }>;
        };
      };
      const out: Record<string, LiveQuote> = {};
      for (const r of json.quoteResponse?.result ?? []) {
        if (typeof r.regularMarketPrice !== "number") continue;
        out[r.symbol] = {
          symbol: r.symbol,
          price: r.regularMarketPrice,
          change: r.regularMarketChange ?? 0,
          changePercent: r.regularMarketChangePercent ?? 0,
          previousClose: r.regularMarketPreviousClose ?? r.regularMarketPrice,
          marketState: r.marketState,
        };
      }
      return out;
    } catch {
      return {};
    }
  });

// ============ News ============
export type NewsItem = {
  title: string;
  publisher: string;
  link: string;
  publishedAt: number;
  scope: "company" | "sector" | "market" | "global";
};

async function fetchYahooNews(query: string, count = 8): Promise<Omit<NewsItem, "scope">[]> {
  const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&newsCount=${count}&quotesCount=0`;
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" },
    });
    if (!res.ok) return [];
    const json = (await res.json()) as {
      news?: Array<{ title?: string; publisher?: string; link?: string; providerPublishTime?: number }>;
    };
    return (json.news ?? [])
      .filter((n) => n.title && n.link)
      .map((n) => ({
        title: n.title!,
        publisher: n.publisher ?? "",
        link: n.link!,
        publishedAt: n.providerPublishTime ?? 0,
      }));
  } catch {
    return [];
  }
}

// Best-effort sector inference from symbol metadata
async function inferSector(symbol: string): Promise<string | null> {
  try {
    const url = `https://query2.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(symbol)}&quotesCount=1&newsCount=0`;
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" } });
    if (!res.ok) return null;
    const json = (await res.json()) as { quotes?: Array<{ sector?: string; industry?: string }> };
    return json.quotes?.[0]?.sector ?? json.quotes?.[0]?.industry ?? null;
  } catch { return null; }
}

export const getNews = createServerFn({ method: "POST" })
  .inputValidator((input: { symbol: string; companyName?: string }) => ({
    symbol: String(input.symbol).toUpperCase().slice(0, 10),
    companyName: input.companyName ? String(input.companyName).slice(0, 80) : "",
  }))
  .handler(async ({ data }): Promise<{ items: NewsItem[]; sector: string | null }> => {
    const sector = await inferSector(data.symbol);
    const [company, sectorNews, market, global] = await Promise.all([
      fetchYahooNews(data.companyName || data.symbol, 8),
      sector ? fetchYahooNews(sector, 4) : Promise.resolve([]),
      fetchYahooNews("stock market today", 4),
      fetchYahooNews("world economy", 3),
    ]);
    const items: NewsItem[] = [
      ...company.map((n) => ({ ...n, scope: "company" as const })),
      ...sectorNews.map((n) => ({ ...n, scope: "sector" as const })),
      ...market.map((n) => ({ ...n, scope: "market" as const })),
      ...global.map((n) => ({ ...n, scope: "global" as const })),
    ];
    return { items, sector };
  });

// ============ AI sentiment analysis (Lovable AI Gateway) ============
export type SentimentResult = {
  score: number; // -1 bearish .. +1 bullish
  label: "BULLISH" | "BEARISH" | "NEUTRAL";
  summary: string;
  drivers: string[];
};

export const analyzeNewsSentiment = createServerFn({ method: "POST" })
  .inputValidator((input: { symbol: string; headlines: { title: string; scope: string }[] }) => ({
    symbol: String(input.symbol).toUpperCase().slice(0, 10),
    headlines: (Array.isArray(input.headlines) ? input.headlines : [])
      .slice(0, 25)
      .map((h) => ({ title: String(h.title).slice(0, 240), scope: String(h.scope).slice(0, 16) })),
  }))
  .handler(async ({ data }): Promise<SentimentResult> => {
    const apiKey = process.env.LOVABLE_API_KEY;
    if (!apiKey || data.headlines.length === 0) {
      return { score: 0, label: "NEUTRAL", summary: "No news available.", drivers: [] };
    }
    const lines = data.headlines.map((h, i) => `${i + 1}. [${h.scope}] ${h.title}`).join("\n");
    const prompt = `You are an equities analyst evaluating short-term price impact for ${data.symbol}.
Headlines (company, sector, market, global):
${lines}

Weight company news most, then sector, then market/global. Return JSON ONLY.`;
    try {
      const res = await fetch("https://ai.gateway.lovable.dev/v1/chat/completions", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model: "google/gemini-2.5-flash",
          messages: [
            { role: "system", content: "Respond with strict JSON: {score:number(-1..1), label:'BULLISH'|'BEARISH'|'NEUTRAL', summary:string<=240chars, drivers:string[]<=4}." },
            { role: "user", content: prompt },
          ],
          response_format: { type: "json_object" },
        }),
      });
      if (!res.ok) {
        return { score: 0, label: "NEUTRAL", summary: `AI error ${res.status}`, drivers: [] };
      }
      const json = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
      const content = json.choices?.[0]?.message?.content ?? "{}";
      const parsed = JSON.parse(content) as Partial<SentimentResult>;
      const score = Math.max(-1, Math.min(1, Number(parsed.score ?? 0)));
      const label = (parsed.label === "BULLISH" || parsed.label === "BEARISH") ? parsed.label : "NEUTRAL";
      return {
        score,
        label,
        summary: String(parsed.summary ?? "").slice(0, 280),
        drivers: Array.isArray(parsed.drivers) ? parsed.drivers.slice(0, 4).map((s) => String(s).slice(0, 120)) : [],
      };
    } catch (err) {
      return { score: 0, label: "NEUTRAL", summary: "AI request failed.", drivers: [] };
    }
  });