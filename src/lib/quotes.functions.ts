import { createServerFn } from "@tanstack/react-start";
import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

// ============ Yahoo crumb+cookie cache (required for v7 quote endpoint) ============
let yahooAuth: { cookie: string; crumb: string; at: number } | undefined;
const YAHOO_AUTH_TTL_MS = 30 * 60 * 1000; // 30 min
// Negative cache: when Yahoo rate-limits us (429), back off instead of
// hammering on every poll.
let yahooAuthCooldownUntil = 0;
const YAHOO_AUTH_COOLDOWN_MS = 10 * 60 * 1000; // 10 min
const YAHOO_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
// Keep the upstream cache short so the header bid/ask reflects the
// freshest snapshot we can pull. (Yahoo's free feed is best-effort, not
// a real NBBO tape — true millisecond bid/ask requires a paid provider.)
const LIVE_QUOTE_CACHE_MS = 250;
let liveQuoteCache: { key: string; at: number; data: Record<string, LiveQuote> } | undefined;

async function getYahooAuth(): Promise<{ cookie: string; crumb: string } | null> {
  if (yahooAuth && Date.now() - yahooAuth.at < YAHOO_AUTH_TTL_MS) {
    return { cookie: yahooAuth.cookie, crumb: yahooAuth.crumb };
  }
  if (Date.now() < yahooAuthCooldownUntil) return null;
  // Try multiple cookie sources — workerd's fetch sometimes drops Set-Cookie
  // from fc.yahoo.com's 302; finance.yahoo.com is more reliable.
  const cookieSources = [
    "https://finance.yahoo.com/quote/AAPL/",
    "https://fc.yahoo.com/",
  ];
  for (const src of cookieSources) {
    try {
      const c = await fetch(src, {
        headers: { "User-Agent": YAHOO_UA, Accept: "text/html,*/*" },
        redirect: "manual",
      });
      // workerd exposes Set-Cookie via getSetCookie() (Web standard) when available
      const h = c.headers as Headers & { getSetCookie?: () => string[] };
      const setCookies: string[] =
        typeof h.getSetCookie === "function"
          ? h.getSetCookie()
          : (c.headers.get("set-cookie") ?? "").split(/,(?=[^ ]+=)/);
      const cookie = setCookies
        .map((p) => p.split(";")[0].trim())
        .filter((p) => p && /^[A-Za-z0-9_]+=/.test(p))
        .join("; ");
      if (!cookie) continue;
      // Try crumb on both query1 and query2 — sometimes one is blocked
      for (const host of ["query2.finance.yahoo.com", "query1.finance.yahoo.com"]) {
        const r = await fetch(`https://${host}/v1/test/getcrumb`, {
          headers: { "User-Agent": YAHOO_UA, Cookie: cookie, Accept: "*/*" },
        });
        const crumb = r.ok ? (await r.text()).trim() : "";
        if (r.ok && crumb && crumb.length >= 4 && !crumb.startsWith("<")) {
          yahooAuth = { cookie, crumb, at: Date.now() };
          return { cookie, crumb };
        }
        if (r.status === 429) {
          yahooAuthCooldownUntil = Date.now() + YAHOO_AUTH_COOLDOWN_MS;
          return null;
        }
      }
    } catch {
      /* try next source */
    }
  }
  yahooAuthCooldownUntil = Date.now() + 60_000;
  return null;
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
  regularMarketOpen?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  syntheticBidAsk?: boolean;
};

function saneBidAsk(mark: number, bid?: number | null, ask?: number | null, session?: LiveQuote["session"]): { bid?: number; ask?: number } {
  if (!Number.isFinite(mark) || mark <= 0) return {};
  if (typeof bid !== "number" || typeof ask !== "number" || !Number.isFinite(bid) || !Number.isFinite(ask)) return {};
  if (bid <= 0 || ask <= 0 || ask < bid) return {};
  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  const extended = session === "PRE" || session === "POST" || session === "OVERNIGHT" || session === "CLOSED";
  // Reject stale/outlier NBBO like MRVL bid 262 / ask 277 against a ~$274 mark.
  // A wide quote is worse than no quote; the UI will fall back to a tight mark-based estimate.
  const maxSpread = Math.max(mark * (extended ? 0.03 : 0.015), mark < 5 ? 0.08 : 0.05);
  const maxMidDrift = Math.max(mark * (extended ? 0.018 : 0.008), mark < 5 ? 0.05 : 0.03);
  if (spread > maxSpread) return {};
  if (Math.abs(mid - mark) > maxMidDrift) return {};
  return { bid, ask };
}

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
    const clean = saneBidAsk(price, q.bid, q.ask, session);
    const cleanBid = clean.bid;
    const cleanAsk = clean.ask;
    if (process.env.NODE_ENV !== "production" && (q.bid != null || q.ask != null)) {
      // eslint-disable-next-line no-console
      console.log("[getLiveQuotes]", q.symbol, {
        mark: price, rawBid: q.bid, rawAsk: q.ask,
        cleanBid, cleanAsk, bidSize: q.bidSize, askSize: q.askSize,
        regularMarketTime: q.regularMarketTime, marketState: q.marketState,
      });
    }
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
      // Yahoo's regularMarketDayHigh/Low can lag the live last-trade tick by a
      // minute or more, so DAY H would sit below a price the tape has already
      // printed. During the regular session, widen the range to include the
      // current mark so DAY H/L never trail visible price action.
      dayHigh: session === "REGULAR" && price != null
        ? Math.max(q.regularMarketDayHigh ?? -Infinity, price)
        : q.regularMarketDayHigh,
      dayLow: session === "REGULAR" && price != null
        ? Math.min(q.regularMarketDayLow ?? Infinity, price)
        : q.regularMarketDayLow,
      open: q.regularMarketOpen,
      bid: cleanBid,
      ask: cleanAsk,
      bidSize: q.bidSize,
      askSize: q.askSize,
    };
  }
  return out;
}

function roundQuotePrice(value: number) {
  return value >= 1 ? Math.round(value * 100) / 100 : Math.round(value * 10_000) / 10_000;
}

function makeBidAsk(mark: number, recentRanges: number[] = []) {
  const avgRange = recentRanges.length ? recentRanges.reduce((s, v) => s + v, 0) / recentRanges.length : 0;
  const halfSpread = Math.max(0.005, Math.min(Math.max(mark * 0.00045, avgRange * 0.04), Math.max(mark * 0.0025, 0.03)));
  return {
    bid: roundQuotePrice(Math.max(0.0001, mark - halfSpread)),
    ask: roundQuotePrice(mark + halfSpread),
  };
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
  // 2y of daily candles so the 200D and 1Y views have enough bars.
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=2y`;
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
  dayHigh?: number;
  dayLow?: number;
  open?: number;
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  syntheticBidAsk?: boolean;
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
  .inputValidator((input: {
    symbol: string;
    interval?: "1m" | "2m" | "5m" | "15m" | "30m" | "60m";
    range?: "1d" | "2d" | "5d" | "1mo" | "60d" | "6mo" | "1y" | "2y";
  }) => ({
    symbol: String(input.symbol).toUpperCase().slice(0, 10),
    interval: ["1m","2m","5m","15m","30m","60m"].includes(input.interval ?? "")
      ? (input.interval as "1m"|"2m"|"5m"|"15m"|"30m"|"60m")
      : "1m",
    range: (["1d","2d","5d","1mo","60d","6mo","1y","2y"] as const).includes(input.range as never)
      ? (input.range as "1d"|"2d"|"5d"|"1mo"|"60d"|"6mo"|"1y"|"2y")
      : "2d",
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
      .filter((s) => typeof s === "string" && /^[A-Z0-9.\-=^]{1,12}$/i.test(s))
      .slice(0, 200);
    return { symbols };
  })
  .handler(async ({ data }): Promise<Record<string, LiveQuote>> => {
    if (data.symbols.length === 0) return {};
    const symbols = [...new Set(data.symbols.map((s) => s.toUpperCase()))];
    const cacheKey = symbols.slice().sort().join(",");
    if (liveQuoteCache?.key === cacheKey && Date.now() - liveQuoteCache.at < LIVE_QUOTE_CACHE_MS) {
      return liveQuoteCache.data;
    }
    // Primary: Yahoo's v7 quote endpoint (same data their website ticks live,
    // including postMarketPrice during extended hours). Free, requires crumb.
    const out: Record<string, LiveQuote> = {};
    let remaining = symbols;
    try {
      const v7 = await fetchYahooV7Quotes(symbols);
      Object.assign(out, v7);
      remaining = symbols.filter((s) => !v7[s] || v7[s].bid == null || v7[s].ask == null);
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
                  regularMarketDayHigh?: number;
                  regularMarketDayLow?: number;
                  regularMarketOpen?: number;
                  currentTradingPeriod?: {
                    pre?: { start: number; end: number };
                    regular?: { start: number; end: number };
                    post?: { start: number; end: number };
                  };
                };
                timestamp?: number[];
                indicators: { quote: Array<{ close: (number | null)[]; high?: (number | null)[]; low?: (number | null)[]; open?: (number | null)[] }> };
              }>;
            };
          };
          const r = json.chart.result?.[0];
          if (!r) return;
          const quote = r.indicators.quote[0];
          const closes = quote?.close ?? [];
          const highs = quote?.high ?? [];
          const lows = quote?.low ?? [];
          const ts = r.timestamp ?? [];
          // Find the most recent non-null tick
          let lastIdx = -1;
          for (let i = closes.length - 1; i >= 0; i--) {
            if (closes[i] != null) { lastIdx = i; break; }
          }
          const meta = r.meta;
          const regularPrice = meta.regularMarketPrice ?? null;
          const prevClose = meta.previousClose ?? meta.chartPreviousClose ?? regularPrice ?? 0;
          if (lastIdx === -1 || prevClose === 0) {
            // Fallback to regular price
            if (regularPrice != null) {
              const spread = makeBidAsk(regularPrice);
              out[sym] = {
                symbol: sym,
                price: regularPrice,
                change: regularPrice - (prevClose || regularPrice),
                changePercent: prevClose ? ((regularPrice - prevClose) / prevClose) * 100 : 0,
                previousClose: prevClose || regularPrice,
                marketState: "CLOSED",
                session: "CLOSED",
                regularPrice: regularPrice ?? undefined,
                bid: spread.bid,
                ask: spread.ask,
                syntheticBidAsk: true,
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
          const recentRanges: number[] = [];
          for (let i = Math.max(0, lastIdx - 20); i <= lastIdx; i++) {
            const h = highs[i]; const l = lows[i];
            if (h != null && l != null && h >= l) recentRanges.push(h - l);
          }
          const prior = out[sym];
          const cleanPrior = prior ? saneBidAsk(lastPrice, prior.bid, prior.ask, session) : {};
          const spread = cleanPrior.bid != null && cleanPrior.ask != null
            ? { bid: cleanPrior.bid, ask: cleanPrior.ask }
            : makeBidAsk(lastPrice, recentRanges);
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
            dayHigh: meta.regularMarketDayHigh ?? (() => {
              const reg = periods.regular;
              const highs = r.indicators.quote[0]?.high ?? [];
              let hi: number | undefined;
              for (let i = 0; i < highs.length; i++) {
                const h = highs[i]; if (h == null) continue;
                if (reg && (ts[i] < reg.start || ts[i] >= reg.end)) continue;
                if (hi == null || h > hi) hi = h;
              }
              return hi;
            })(),
            dayLow: meta.regularMarketDayLow ?? (() => {
              const reg = periods.regular;
              const lows = r.indicators.quote[0]?.low ?? [];
              let lo: number | undefined;
              for (let i = 0; i < lows.length; i++) {
                const lv = lows[i]; if (lv == null) continue;
                if (reg && (ts[i] < reg.start || ts[i] >= reg.end)) continue;
                if (lo == null || lv < lo) lo = lv;
              }
              return lo;
            })(),
            open: meta.regularMarketOpen ?? (() => {
              const reg = periods.regular;
              const opens = r.indicators.quote[0]?.open ?? [];
              for (let i = 0; i < opens.length; i++) {
                const o = opens[i]; if (o == null) continue;
                if (reg && (ts[i] < reg.start || ts[i] >= reg.end)) continue;
                return o;
              }
              return undefined;
            })(),
            bid: spread.bid,
            ask: spread.ask,
            bidSize: prior?.bidSize,
            askSize: prior?.askSize,
            syntheticBidAsk: cleanPrior.bid != null && cleanPrior.ask != null ? false : true,
          };
          if (process.env.NODE_ENV !== "production") {
            console.log(`[quotes] sym=${sym} src=${prior?.bid != null && prior?.ask != null ? "v7" : "v8-spread"} bid=${spread.bid} ask=${spread.ask} age=${Date.now() - lastTs * 1000}ms`);
          }
        } catch {
          /* skip */
        }
      })
    );
    for (const sym of symbols) {
      const q = out[sym];
      if (!q) continue;
      if (q.bid == null || q.ask == null) {
        const spread = makeBidAsk(q.price ?? q.regularPrice ?? q.previousClose);
        out[sym] = { ...q, bid: spread.bid, ask: spread.ask, syntheticBidAsk: true };
      }
      if (process.env.NODE_ENV !== "production") {
        console.log(`[quotes] sym=${sym} src=${out[sym].syntheticBidAsk ? "synthetic" : "v7"} bid=${out[sym].bid} ask=${out[sym].ask} age=${out[sym].lastTickTime ? Date.now() - out[sym].lastTickTime! * 1000 : 0}ms`);
      }
    }
    liveQuoteCache = { key: cacheKey, at: Date.now(), data: out };
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
  .middleware([requireSupabaseAuth])
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
      .slice(0, 200),
    interval: (["1m", "2m", "5m"] as const).includes(input?.interval as "1m" | "2m" | "5m")
      ? (input.interval as "1m" | "2m" | "5m")
      : "5m",
    range: input?.range === "1d" || input?.range === "5d" ? input.range : "2d",
  }))
  .handler(async ({ data }): Promise<Record<string, IntradayBar[]>> => {
    if (data.symbols.length === 0) return {};
    const out: Record<string, IntradayBar[]> = Object.fromEntries(data.symbols.map((sym) => [sym, []]));
    const chunkSize = 12;
    for (let start = 0; start < data.symbols.length; start += chunkSize) {
      const chunk = data.symbols.slice(start, start + chunkSize);
      await Promise.all(
        chunk.map(async (sym) => {
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
    }
    return out;
  });

// ============ Nasdaq real-time bid/ask backup ============
// The current Polygon key in this project is not entitled to stock quotes, so
// we read bid/ask from Nasdaq's public real-time quote endpoint instead.
export type BidAsk = {
  bid?: number;
  ask?: number;
  bidSize?: number;
  askSize?: number;
  asOf?: number;
};

export const getBidAsk = createServerFn({ method: "POST" })
  .inputValidator((input: { symbol: string }) => {
    if (!input || typeof input.symbol !== "string") throw new Error("symbol required");
    const symbol = input.symbol.toUpperCase().replace(/[^A-Z0-9.\-]/g, "").slice(0, 10);
    if (!symbol) throw new Error("symbol required");
    return { symbol };
  })
  .handler(async ({ data }): Promise<BidAsk> => {
    // Pre-June-7 working implementation: Yahoo Finance v7 detail endpoint
    // with a simple Mozilla User-Agent. Try query1 first, fall back to query2.
    const fields = "bid,ask,bidSize,askSize,regularMarketPrice,regularMarketPreviousClose,regularMarketOpen";
    for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
      try {
        const url = `https://${host}/v7/finance/quote?symbols=${encodeURIComponent(data.symbol)}&fields=${fields}`;
        const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
        if (!res.ok) continue;
        const json = (await res.json()) as {
          quoteResponse?: {
            result?: Array<{ bid?: number; ask?: number; bidSize?: number; askSize?: number; regularMarketTime?: number }>;
          };
        };
        const q = json.quoteResponse?.result?.[0];
        if (!q) continue;
        const bid = typeof q.bid === "number" && q.bid > 0 ? q.bid : undefined;
        const ask = typeof q.ask === "number" && q.ask > 0 ? q.ask : undefined;
        if (bid == null && ask == null) continue;
        return {
          bid,
          ask,
          bidSize: typeof q.bidSize === "number" ? q.bidSize : undefined,
          askSize: typeof q.askSize === "number" ? q.askSize : undefined,
          asOf: q.regularMarketTime ? q.regularMarketTime * 1000 : Date.now(),
        };
      } catch {
        /* try next host */
      }
    }
    return {};
  });

// ============ Screener: gainers / losers / most actives ============
export type ScreenerRow = {
  symbol: string;
  name: string;
  price: number | null;
  change: number | null;
  changePct: number | null;
  volume: number | null;
  marketCap: number | null;
  high: number | null;
  low: number | null;
  open: number | null;
};

type YahooScreenerQuote = {
  symbol?: string;
  shortName?: string;
  longName?: string;
  regularMarketPrice?: number;
  regularMarketChange?: number;
  regularMarketChangePercent?: number;
  regularMarketVolume?: number;
  marketCap?: number;
  regularMarketDayHigh?: number;
  regularMarketDayLow?: number;
  regularMarketOpen?: number;
};

async function fetchYahooScreener(scrId: string, count: number, session?: "PRE" | "POST"): Promise<ScreenerRow[]> {
  const sessionQs = session ? `&session=${session}` : "";
  const url = `https://query1.finance.yahoo.com/v1/finance/screener/predefined/saved?scrIds=${scrId}&count=${count}&start=0${sessionQs}`;
  try {
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0" } });
    if (!res.ok) return [];
    const json = (await res.json()) as { finance?: { result?: Array<{ quotes?: YahooScreenerQuote[] }> } };
    const quotes = json.finance?.result?.[0]?.quotes ?? [];
    return quotes
      .filter((q) => q.symbol)
      .map((q) => ({
        symbol: q.symbol!,
        name: q.shortName ?? q.longName ?? q.symbol!,
        price: q.regularMarketPrice ?? null,
        change: q.regularMarketChange ?? null,
        changePct: q.regularMarketChangePercent ?? null,
        volume: q.regularMarketVolume ?? null,
        marketCap: q.marketCap ?? null,
        high: q.regularMarketDayHigh ?? null,
        low: q.regularMarketDayLow ?? null,
        open: q.regularMarketOpen ?? null,
      }));
  } catch {
    return [];
  }
}

export const fetchScreener = createServerFn({ method: "GET" }).handler(
  async (): Promise<{ gainers: ScreenerRow[]; losers: ScreenerRow[]; actives: ScreenerRow[] }> => {
    // Merge multiple Yahoo predefined screeners so the gainers list captures
    // small/micro-cap and penny names too (Yahoo's day_gainers list is capped
    // at $2B+ market cap). small_cap_gainers + aggressive_small_caps cover
    // sub-$2B and OTC names that move on big % days.
    const [gReg, gPre, gSmall, gAggro, losers, lSmall, actives, sActives] = await Promise.all([
      fetchYahooScreener("day_gainers", 100),
      fetchYahooScreener("day_gainers", 100, "PRE"),
      fetchYahooScreener("small_cap_gainers", 100),
      fetchYahooScreener("aggressive_small_caps", 100),
      fetchYahooScreener("day_losers", 50),
      fetchYahooScreener("small_cap_gainers", 50).then((rs) => rs.filter((r) => (r.changePct ?? 0) < 0)),
      fetchYahooScreener("most_actives", 50),
      fetchYahooScreener("most_actives_small_cap", 50),
    ]);
    // Merge + dedup by symbol, keep the row with the strongest move
    const gMap = new Map<string, ScreenerRow>();
    for (const r of [...gReg, ...gPre, ...gSmall, ...gAggro]) {
      if ((r.changePct ?? 0) <= 0) continue;
      const cur = gMap.get(r.symbol);
      if (!cur || (r.changePct ?? -Infinity) > (cur.changePct ?? -Infinity)) gMap.set(r.symbol, r);
    }
    const gainers = Array.from(gMap.values()).sort((a, b) => (b.changePct ?? 0) - (a.changePct ?? 0));
    const lMap = new Map<string, ScreenerRow>();
    for (const r of [...losers, ...lSmall]) {
      const cur = lMap.get(r.symbol);
      if (!cur || (r.changePct ?? Infinity) < (cur.changePct ?? Infinity)) lMap.set(r.symbol, r);
    }
    const aMap = new Map<string, ScreenerRow>();
    for (const r of [...actives, ...sActives]) {
      const cur = aMap.get(r.symbol);
      if (!cur || (r.volume ?? 0) > (cur.volume ?? 0)) aMap.set(r.symbol, r);
    }
    return {
      gainers,
      losers: Array.from(lMap.values()).sort((a, b) => (a.changePct ?? 0) - (b.changePct ?? 0)),
      actives: Array.from(aMap.values()).sort((a, b) => (b.volume ?? 0) - (a.volume ?? 0)),
    };
  },
);
