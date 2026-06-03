import { createServerFn } from "@tanstack/react-start";

// ============ Yahoo crumb+cookie cache (required for v7 quote endpoint) ============
let yahooAuth: { cookie: string; crumb: string; at: number } | undefined;
const YAHOO_AUTH_TTL_MS = 30 * 60 * 1000; // 30 min
const YAHOO_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

async function getYahooAuth(): Promise<{ cookie: string; crumb: string } | null> {
  if (yahooAuth && Date.now() - yahooAuth.at < YAHOO_AUTH_TTL_MS) {
    return { cookie: yahooAuth.cookie, crumb: yahooAuth.crumb };
  }
  try {
    // Step 1: hit fc.yahoo.com to receive A1/A3 session cookies
    const c = await fetch("https://fc.yahoo.com/", {
      headers: { "User-Agent": YAHOO_UA },
      redirect: "manual",
    });
    const setCookie = c.headers.get("set-cookie") ?? "";
    // Reduce to "name=value" pairs joined with "; "
    const cookie = setCookie
      .split(/,(?=[^ ]+=)/)
      .map((p) => p.split(";")[0].trim())
      .filter(Boolean)
      .join("; ");
    if (!cookie) return null;
    // Step 2: fetch the crumb using that cookie
    const r = await fetch("https://query2.finance.yahoo.com/v1/test/getcrumb", {
      headers: { "User-Agent": YAHOO_UA, Cookie: cookie },
    });
    if (!r.ok) return null;
    const crumb = (await r.text()).trim();
    if (!crumb || crumb.length < 4) return null;
    yahooAuth = { cookie, crumb, at: Date.now() };
    return { cookie, crumb };
  } catch {
    return null;
  }
}

type YahooQuoteV7 = {
  symbol: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketPreviousClose?: number;
  marketState?: string;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  preMarketTime?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  postMarketTime?: number;
  regularMarketTime?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
};

async function fetchYahooV7Quotes(symbols: string[]): Promise<Record<string, LiveQuote>> {
  const auth = await getYahooAuth();
  if (!auth) return {};
  const out: Record<string, LiveQuote> = {};
  // Yahoo v7 caps ~50 symbols per request — batch in chunks of 40.
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 40) chunks.push(symbols.slice(i, i + 40));
  const results = await Promise.all(
    chunks.map(async (chunk) => {
      const url = `https://query1.finance.yahoo.com/v7/finance/quote?symbols=${encodeURIComponent(
        chunk.join(","),
      )}&crumb=${encodeURIComponent(auth.crumb)}`;
      const res = await fetch(url, {
        headers: { "User-Agent": YAHOO_UA, Cookie: auth.cookie },
      });
      if (!res.ok) {
        if (res.status === 401 || res.status === 403) yahooAuth = undefined;
        return [] as YahooQuoteV7[];
      }
      const json = (await res.json()) as { quoteResponse?: { result?: YahooQuoteV7[] } };
      return json.quoteResponse?.result ?? [];
    }),
  );
  for (const q of results.flat()) {
    const reg = q.regularMarketPrice;
    const prev = q.regularMarketPreviousClose ?? reg ?? 0;
    if (reg == null || !prev) continue;
    const state = (q.marketState ?? "").toUpperCase();
    // Pick the "live" price + tick time Yahoo's website shows
    let price = reg;
    let lastTickTime = q.regularMarketTime;
    let session: LiveQuote["session"] = "REGULAR";
    let marketState = state || "REGULAR";
    if (state === "PRE" && q.preMarketPrice != null) {
      price = q.preMarketPrice;
      lastTickTime = q.preMarketTime ?? lastTickTime;
      session = "PRE";
    } else if ((state === "POST" || state === "POSTPOST" || state === "CLOSED") && q.postMarketPrice != null) {
      price = q.postMarketPrice;
      lastTickTime = q.postMarketTime ?? lastTickTime;
      session = state === "POSTPOST" || state === "CLOSED" ? "OVERNIGHT" : "POST";
      marketState = session;
    } else if (state === "REGULAR") {
      session = "REGULAR";
    } else if (state === "PREPRE") {
      session = "OVERNIGHT";
      marketState = "OVERNIGHT";
    }
    const change = price - prev;
    out[q.symbol] = {
      symbol: q.symbol,
      price,
      change,
      changePercent: (change / prev) * 100,
      previousClose: prev,
      marketState,
      session,
      regularPrice: reg,
      preMarketPrice: q.preMarketPrice,
      preMarketChange: q.preMarketChange,
      preMarketChangePercent: q.preMarketChangePercent,
      postMarketPrice: q.postMarketPrice,
      postMarketChange: q.postMarketChange,
      postMarketChangePercent: q.postMarketChangePercent,
      // When in overnight window, surface post* as overnight* too
      overnightPrice: session === "OVERNIGHT" ? q.postMarketPrice : undefined,
      overnightChange: session === "OVERNIGHT" && q.postMarketPrice != null ? q.postMarketPrice - prev : undefined,
      overnightChangePercent:
        session === "OVERNIGHT" && q.postMarketPrice != null ? ((q.postMarketPrice - prev) / prev) * 100 : undefined,
      lastTickTime,
      fiftyTwoWeekHigh: q.fiftyTwoWeekHigh,
      fiftyTwoWeekLow: q.fiftyTwoWeekLow,
      dayHigh: q.regularMarketDayHigh,
      dayLow: q.regularMarketDayLow,
    };
  }
  return out;
}

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
      .slice(0, 200);
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
  session: "PRE" | "REGULAR" | "POST" | "OVERNIGHT" | "CLOSED";
  regularPrice?: number;
  preMarketPrice?: number;
  preMarketChange?: number;
  preMarketChangePercent?: number;
  postMarketPrice?: number;
  postMarketChange?: number;
  postMarketChangePercent?: number;
  overnightPrice?: number;
  overnightChange?: number;
  overnightChangePercent?: number;
  lastTickTime?: number;
  fiftyTwoWeekHigh?: number;
  fiftyTwoWeekLow?: number;
};

// ============ Intraday 1-minute candles for day-trade signals ============
export type IntradayBar = {
  t: number; // unix seconds
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
};

export const getIntraday = createServerFn({ method: "POST" })
  .inputValidator((input: { symbol: string; interval?: "1m" | "2m" | "5m" | "15m" | "30m" | "60m"; range?: "1d" | "2d" | "5d" }) => ({
    symbol: String(input.symbol).toUpperCase().slice(0, 10),
    interval: ["1m","2m","5m","15m","30m","60m"].includes(input.interval ?? "")
      ? (input.interval as "1m"|"2m"|"5m"|"15m"|"30m"|"60m")
      : "1m",
    range: input.range === "5d" || input.range === "1d" ? input.range : "2d",
  }))
  .handler(async ({ data }): Promise<IntradayBar[]> => {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(data.symbol)}?interval=${data.interval}&range=${data.range}&includePrePost=true`;
    try {
      const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" } });
      if (!res.ok) return [];
      const json = (await res.json()) as {
        chart: {
          result?: Array<{
            timestamp?: number[];
            indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> };
          }>;
        };
      };
      const r = json.chart.result?.[0];
      if (!r) return [];
      const q = r.indicators.quote[0];
      const ts = r.timestamp ?? [];
      const out: IntradayBar[] = [];
      for (let i = 0; i < ts.length; i++) {
        const c = q.close[i];
        if (c == null) continue;
        out.push({
          t: ts[i],
          open: q.open[i] ?? c,
          high: q.high[i] ?? c,
          low: q.low[i] ?? c,
          close: c,
          volume: q.volume[i] ?? 0,
        });
      }
      return out;
    } catch {
      return [];
    }
  });

export const getLiveQuotes = createServerFn({ method: "POST" })
  .inputValidator((input: { symbols: string[] }) => {
    if (!input || !Array.isArray(input.symbols)) throw new Error("symbols required");
    const symbols = input.symbols
      .filter((s) => typeof s === "string" && /^[A-Z.\-]{1,10}$/i.test(s))
      .slice(0, 200);
    return { symbols };
  })
  .handler(async ({ data }): Promise<Record<string, LiveQuote>> => {
    if (data.symbols.length === 0) return {};
    // Primary: Yahoo's v7 quote endpoint (same data their website ticks live,
    // including postMarketPrice during extended hours). Free, requires crumb.
    const out: Record<string, LiveQuote> = {};
    let remaining = data.symbols;
    try {
      const v7 = await fetchYahooV7Quotes(data.symbols);
      Object.assign(out, v7);
      remaining = data.symbols.filter((s) => !v7[s]);
      if (remaining.length === 0) return out;
    } catch {
      /* fall through to chart for all symbols */
    }
    // Fallback: v8 chart endpoint per-symbol with includePrePost=true.
    // This returns the latest tick across PRE, REGULAR, and POST sessions
    // (v7 quote often returns stale postMarketPrice or requires a crumb).
    await Promise.all(
      remaining.map(async (sym) => {
        try {
          // Use range=2d so the response spans overnight (post-close 8pm ET through next-day pre-market 4am ET).
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=1m&range=2d&includePrePost=true`;
          const res = await fetch(url, {
            headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" },
          });
          if (!res.ok) return;
          const json = (await res.json()) as {
            chart: {
              result?: Array<{
                meta: {
                  symbol: string;
                  regularMarketPrice?: number;
                  previousClose?: number;
                  chartPreviousClose?: number;
                  fiftyTwoWeekHigh?: number;
                  fiftyTwoWeekLow?: number;
                  currentTradingPeriod?: {
                    pre?: { start: number; end: number };
                    regular?: { start: number; end: number };
                    post?: { start: number; end: number };
                  };
                };
                timestamp?: number[];
                indicators: { quote: Array<{ close: (number | null)[] }> };
              }>;
            };
          };
          const r = json.chart.result?.[0];
          if (!r) return;
          const closes = r.indicators.quote[0]?.close ?? [];
          const ts = r.timestamp ?? [];
          // Find the most recent non-null tick
          let lastIdx = -1;
          for (let i = closes.length - 1; i >= 0; i--) {
            if (closes[i] != null) { lastIdx = i; break; }
          }
          const meta = r.meta;
          const regularPrice = meta.regularMarketPrice ?? null;
          const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? regularPrice ?? 0;
          if (lastIdx === -1 || prevClose === 0) {
            // Fallback to regular price
            if (regularPrice != null) {
              out[sym] = {
                symbol: sym,
                price: regularPrice,
                change: regularPrice - (prevClose || regularPrice),
                changePercent: prevClose ? ((regularPrice - prevClose) / prevClose) * 100 : 0,
                previousClose: prevClose || regularPrice,
                marketState: "CLOSED",
                session: "CLOSED",
                regularPrice: regularPrice ?? undefined,
              };
            }
            return;
          }
          const lastPrice = closes[lastIdx]!;
          const lastTs = ts[lastIdx];
          const periods = meta.currentTradingPeriod ?? {};
          // Determine session from timestamp vs period windows.
          // Yahoo period windows: pre 4:00-9:30 ET, regular 9:30-16:00 ET, post 16:00-20:00 ET.
          // 20:00 ET -> next-day 04:00 ET is the OVERNIGHT (24H) window.
          let session: LiveQuote["session"] = "CLOSED";
          let marketState = "CLOSED";
          if (periods.regular && lastTs >= periods.regular.start && lastTs < periods.regular.end) {
            session = "REGULAR"; marketState = "REGULAR";
          } else if (periods.pre && lastTs >= periods.pre.start && lastTs < periods.pre.end) {
            session = "PRE"; marketState = "PRE";
          } else if (periods.post && lastTs >= periods.post.start && lastTs < periods.post.end) {
            session = "POST"; marketState = "POST";
          } else if (periods.post && lastTs >= periods.post.end) {
            // After 8pm ET — overnight 24-hour trading window
            session = "OVERNIGHT"; marketState = "OVERNIGHT";
          } else if (periods.pre && lastTs < periods.pre.start) {
            // Before next-day 4am ET (carry-over overnight session)
            session = "OVERNIGHT"; marketState = "OVERNIGHT";
          }
          // Build pre/post derived prices: take the last tick within each window
          const pickLastInWindow = (start?: number, end?: number) => {
            if (!start || !end) return undefined;
            for (let i = closes.length - 1; i >= 0; i--) {
              if (closes[i] != null && ts[i] >= start && ts[i] < end) return closes[i]!;
            }
            return undefined;
          };
          const preLast = pickLastInWindow(periods.pre?.start, periods.pre?.end);
          const postLast = pickLastInWindow(periods.post?.start, periods.post?.end);
          const reg = regularPrice ?? pickLastInWindow(periods.regular?.start, periods.regular?.end);
          // Overnight: any tick strictly after post.end OR strictly before pre.start (carry-over)
          let overnightLast: number | undefined;
          if (periods.post?.end) {
            for (let i = closes.length - 1; i >= 0; i--) {
              if (closes[i] != null && ts[i] >= periods.post.end && (!periods.pre || ts[i] < periods.pre.start)) {
                overnightLast = closes[i]!;
                break;
              }
            }
          }
          const change = lastPrice - prevClose;
          out[sym] = {
            symbol: sym,
            price: lastPrice,
            change,
            changePercent: (change / prevClose) * 100,
            previousClose: prevClose,
            marketState,
            session,
            regularPrice: reg ?? undefined,
            preMarketPrice: preLast,
            preMarketChange: preLast != null ? preLast - prevClose : undefined,
            preMarketChangePercent: preLast != null ? ((preLast - prevClose) / prevClose) * 100 : undefined,
            postMarketPrice: postLast,
            postMarketChange: postLast != null && reg != null ? postLast - reg : undefined,
            postMarketChangePercent: postLast != null && reg != null ? ((postLast - reg) / reg) * 100 : undefined,
            overnightPrice: overnightLast,
            overnightChange: overnightLast != null ? overnightLast - prevClose : undefined,
            overnightChangePercent: overnightLast != null ? ((overnightLast - prevClose) / prevClose) * 100 : undefined,
            lastTickTime: lastTs,
            fiftyTwoWeekHigh: meta.fiftyTwoWeekHigh,
            fiftyTwoWeekLow: meta.fiftyTwoWeekLow,
          };
        } catch {
          /* skip */
        }
      })
    );
    return out;
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
// Batch intraday fetch — pulls bars for many watchlist symbols in parallel
// so the client can compute per-symbol MACD signals on a frequent interval
// without firing one request per symbol from the browser.
export const getIntradayBatch = createServerFn({ method: "POST" })
  .inputValidator((input: { symbols: string[]; interval?: "1m" | "2m" | "5m"; range?: "1d" | "2d" | "5d" }) => ({
    symbols: (Array.isArray(input?.symbols) ? input.symbols : [])
      .filter((s) => typeof s === "string" && /^[A-Z.\-]{1,10}$/i.test(s))
      .map((s) => s.toUpperCase())
      .slice(0, 50),
    interval: (["1m", "2m", "5m"] as const).includes(input?.interval as "1m" | "2m" | "5m")
      ? (input.interval as "1m" | "2m" | "5m")
      : "5m",
    range: input?.range === "1d" || input?.range === "5d" ? input.range : "2d",
  }))
  .handler(async ({ data }): Promise<Record<string, IntradayBar[]>> => {
    if (data.symbols.length === 0) return {};
    const out: Record<string, IntradayBar[]> = {};
    await Promise.all(
      data.symbols.map(async (sym) => {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(sym)}?interval=${data.interval}&range=${data.range}&includePrePost=true`;
        try {
          const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; BryanTrade/1.0)" } });
          if (!res.ok) { out[sym] = []; return; }
          const json = (await res.json()) as {
            chart: { result?: Array<{ timestamp?: number[]; indicators: { quote: Array<{ open: (number | null)[]; high: (number | null)[]; low: (number | null)[]; close: (number | null)[]; volume: (number | null)[] }> } }> };
          };
          const r = json.chart.result?.[0];
          if (!r) { out[sym] = []; return; }
          const q = r.indicators.quote[0];
          const ts = r.timestamp ?? [];
          const bars: IntradayBar[] = [];
          for (let i = 0; i < ts.length; i++) {
            const c = q.close[i];
            if (c == null) continue;
            bars.push({
              t: ts[i],
              open: q.open[i] ?? c,
              high: q.high[i] ?? c,
              low: q.low[i] ?? c,
              close: c,
              volume: q.volume[i] ?? 0,
            });
          }
          out[sym] = bars;
        } catch {
          out[sym] = [];
        }
      })
    );
    return out;
  });
