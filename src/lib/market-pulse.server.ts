const UA = "Mozilla/5.0 (compatible; BryanTrade/1.0)";

const ASIA_SEMIS: { symbol: string; name: string }[] = [
  { symbol: "2330.TW", name: "TSMC" },
  { symbol: "005930.KS", name: "Samsung" },
  { symbol: "000660.KS", name: "SK Hynix" },
  { symbol: "8035.T", name: "Tokyo Electron" },
  { symbol: "6857.T", name: "Advantest" },
];

const US_FUTURES: { symbol: string; name: string }[] = [
  { symbol: "ES=F", name: "S&P 500" },
  { symbol: "NQ=F", name: "Nasdaq 100" },
  { symbol: "YM=F", name: "Dow" },
  { symbol: "RTY=F", name: "Russell 2K" },
];

const SEMIS_BASKET: { symbol: string; name: string }[] = [
  { symbol: "NVDA", name: "NVIDIA" },
  { symbol: "AMD", name: "AMD" },
  { symbol: "AVGO", name: "Broadcom" },
  { symbol: "TSM", name: "TSMC ADR" },
  { symbol: "MU", name: "Micron" },
  { symbol: "INTC", name: "Intel" },
  { symbol: "QCOM", name: "Qualcomm" },
  { symbol: "ASML", name: "ASML" },
  { symbol: "LRCX", name: "Lam Research" },
  { symbol: "AMAT", name: "Applied Materials" },
  { symbol: "KLAC", name: "KLA" },
  { symbol: "MRVL", name: "Marvell" },
];

export type AsiaSemiComponent = { symbol: string; name: string; changePct: number | null };
export type AsiaSemisResponse = {
  avgChangePct: number | null;
  components: AsiaSemiComponent[];
  asOf: number;
  error?: string;
};

export type QuoteSnap = {
  symbol: string;
  name: string;
  price: number | null;
  changePct: number | null;
};

export type MarketPulseResponse = {
  futures: QuoteSnap[];
  vix: QuoteSnap | null;
  semisEtfs: QuoteSnap[]; // SOXX, SMH
  semisBreadth: {
    advancers: number;
    decliners: number;
    unchanged: number;
    avgChangePct: number | null;
    components: QuoteSnap[];
  };
  semisRisk: {
    level: "LOW" | "ELEVATED" | "HIGH" | "EXTREME";
    score: number; // 0..100
    reason: string;
  };
  asOf: number;
  error?: string;
};

export type FastPulseResponse = {
  futures: QuoteSnap[];
  vix: QuoteSnap | null;
  asOf: number;
  error?: string;
};

export type SemisPulseResponse = {
  semisEtfs: QuoteSnap[];
  semisBreadth: MarketPulseResponse["semisBreadth"];
  semisRisk: MarketPulseResponse["semisRisk"];
  asOf: number;
  error?: string;
};

export type GlobalSemiComponent = { symbol: string; name: string; changePct: number | null };
export type GlobalSemiIndexResponse = {
  avgChangePct: number | null;
  components: GlobalSemiComponent[];
  level: "LOW" | "ELEVATED" | "HIGH" | "EXTREME";
  score: number; // 0-100; higher = more risk
  reason: string;
  asOf: number;
  error?: string;
};

export type SemiRiskSentimentResponse = {
  level: "LOW" | "ELEVATED" | "HIGH" | "EXTREME";
  score: number; // 0-100, 50 neutral
  bullishCount: number;
  bearishCount: number;
  headlines: { title: string; publisher: string; link: string }[];
  asOf: number;
  error?: string;
};

const GLOBAL_SEMI_INDICES: { symbol: string; name: string }[] = [
  { symbol: "^KS11", name: "KOSPI" },
  { symbol: "000688.SS", name: "STAR 50" },
  { symbol: "^SOX", name: "PHLX Semi" },
  { symbol: "^TWII", name: "TAIEX" },
  { symbol: "^N225", name: "Nikkei 225" },
  { symbol: "^HSTECH", name: "Hang Seng Tech" },
];

export type NewsItem = {
  title: string;
  link: string;
  publisher: string;
  publishedAt: number | null;
};

export type MacroNewsResponse = {
  items: NewsItem[];
  asOf: number;
  error?: string;
};

const FEEDS: { url: string; publisher: string }[] = [
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", publisher: "CNBC" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", publisher: "MarketWatch" },
  { url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", publisher: "WSJ Markets" },
];

const MARKET_KEYWORDS = [
  "fed", "federal reserve", "powell", "fomc", "rate", "inflation", "cpi", "ppi", "jobs",
  "payroll", "unemployment", "gdp", "treasury", "yield", "bond", "tariff", "trade", "china",
  "oil", "opec", "earnings", "nasdaq", "s&p", "dow", "stock", "market", "recession",
  "semiconductor", "chip", "nvidia", "apple", "microsoft", "tesla", "ai",
];

async function fetchYahooSnap(
  symbol: string,
  opts: { interval?: string; range?: string } = {},
): Promise<{ price: number | null; prev: number | null }> {
  const interval = opts.interval ?? "1d";
  const range = opts.range ?? "5d";
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response = await fetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=${interval}&range=${range}&includePrePost=true`,
        { headers: { "User-Agent": UA, Accept: "application/json" } },
      );

      if (!response.ok) {
        console.error("[market-pulse] fetch failed", symbol, host, response.status);
        continue;
      }

      const json: any = await response.json();
      const result = json?.chart?.result?.[0];
      const meta = result?.meta;
      // For futures the correct % reference is the prior settlement
      // (previousClose). chartPreviousClose can equal the start-of-range bar
      // and skew the percent on multi-day ranges.
      const prev = Number(meta?.previousClose ?? meta?.chartPreviousClose);
      // Prefer the freshest tick available: last non-null 1m bar > meta price.
      let price = Number(meta?.regularMarketPrice);
      const closes: Array<number | null> | undefined = result?.indicators?.quote?.[0]?.close;
      if (Array.isArray(closes)) {
        for (let i = closes.length - 1; i >= 0; i--) {
          const v = closes[i];
          if (v != null && Number.isFinite(v)) {
            if (!Number.isFinite(price) || v !== price) price = Number(v);
            break;
          }
        }
      }
      if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) continue;
      return { price, prev };
    } catch (error) {
      console.error("[market-pulse] error", symbol, host, error);
    }
  }
  return { price: null, prev: null };
}

async function snapFast(symbol: string, name: string): Promise<QuoteSnap> {
  const { price, prev } = await fetchYahooSnap(symbol, { interval: "1m", range: "1d" });
  const changePct = price != null && prev != null && prev > 0 ? ((price - prev) / prev) * 100 : null;
  return { symbol, name, price, changePct };
}

async function fetchAsiaSemiChange(symbol: string): Promise<number | null> {
  const { price, prev } = await fetchYahooSnap(symbol);
  if (price == null || prev == null) return null;
  return ((price - prev) / prev) * 100;
}

function parseRss(xml: string, publisher: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s\S]*?>([\s\S]*?)<\/item>/g;
  let match: RegExpExecArray | null;

  while ((match = itemRe.exec(xml)) && items.length < 20) {
    const block = match[1];
    const get = (tag: string) => {
      const re = new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`);
      const innerMatch = re.exec(block);
      if (!innerMatch) return "";
      return innerMatch[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    };

    const pubDate = get("pubDate");
    const timestamp = pubDate ? Date.parse(pubDate) : NaN;
    items.push({
      title: get("title"),
      link: get("link"),
      publisher,
      publishedAt: Number.isFinite(timestamp) ? Math.floor(timestamp / 1000) : null,
    });
  }

  return items;
}

function isMarketImpacting(title: string): boolean {
  const normalized = title.toLowerCase();
  return MARKET_KEYWORDS.some((keyword) => normalized.includes(keyword));
}

export async function fetchAsiaSemisSnapshot(): Promise<AsiaSemisResponse> {
  try {
    const components: AsiaSemiComponent[] = await Promise.all(
      ASIA_SEMIS.map(async (stock) => ({ ...stock, changePct: await fetchAsiaSemiChange(stock.symbol) })),
    );
    const valid = components.filter((component) => component.changePct != null) as Array<AsiaSemiComponent & { changePct: number }>;
    const avgChangePct = valid.length
      ? valid.reduce((sum, component) => sum + component.changePct, 0) / valid.length
      : null;

    return { avgChangePct, components, asOf: Date.now() };
  } catch (error) {
    console.error("[asia-semis] snapshot failed", error);
    return { avgChangePct: null, components: [], asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
}

export async function fetchMacroNewsSnapshot(): Promise<MacroNewsResponse> {
  try {
    const lists = await Promise.all(
      FEEDS.map(async (feed) => {
        try {
          const response = await fetch(feed.url, {
            headers: { "User-Agent": UA, Accept: "application/rss+xml,*/*" },
          });
          if (!response.ok) return [] as NewsItem[];
          const xml = await response.text();
          return parseRss(xml, feed.publisher);
        } catch {
          return [] as NewsItem[];
        }
      }),
    );

    const all = lists.flat().filter((item) => item.title && isMarketImpacting(item.title));
    const seen = new Set<string>();
    const deduped: NewsItem[] = [];

    for (const item of all) {
      const key = item.title.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      deduped.push(item);
    }

    deduped.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    return { items: deduped.slice(0, 15), asOf: Date.now() };
  } catch (error) {
    console.error("[macro-news] snapshot failed", error);
    return { items: [], asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
}
async function snap(symbol: string, name: string): Promise<QuoteSnap> {
  const { price, prev } = await fetchYahooSnap(symbol);
  const changePct = price != null && prev != null && prev > 0 ? ((price - prev) / prev) * 100 : null;
  return { symbol, name, price, changePct };
}

export async function fetchMarketPulseSnapshot(): Promise<MarketPulseResponse> {
  try {
    const [futures, vix, soxx, smh, basket] = await Promise.all([
      Promise.all(US_FUTURES.map((f) => snap(f.symbol, f.name))),
      snap("^VIX", "VIX"),
      snap("SOXX", "SOXX"),
      snap("SMH", "SMH"),
      Promise.all(SEMIS_BASKET.map((s) => snap(s.symbol, s.name))),
    ]);

    const valid = basket.filter((b) => b.changePct != null) as Array<QuoteSnap & { changePct: number }>;
    const advancers = valid.filter((b) => b.changePct > 0.1).length;
    const decliners = valid.filter((b) => b.changePct < -0.1).length;
    const unchanged = valid.length - advancers - decliners;
    const avgChangePct = valid.length ? valid.reduce((s, b) => s + b.changePct, 0) / valid.length : null;

    // Semis composite risk: blend of VIX level, semis basket move, SOXX/SMH move.
    const vixLevel = vix.price ?? 0;
    const soxxPct = soxx.changePct ?? 0;
    const smhPct = smh.changePct ?? 0;
    const semisPct = avgChangePct ?? 0;
    // Score 0..100. Higher = more risk.
    let score = 0;
    // VIX contribution
    if (vixLevel >= 30) score += 40;
    else if (vixLevel >= 22) score += 28;
    else if (vixLevel >= 18) score += 18;
    else if (vixLevel >= 14) score += 8;
    // Semis weakness contribution (negative moves add risk)
    const worstSemis = Math.min(soxxPct, smhPct, semisPct);
    if (worstSemis <= -3) score += 35;
    else if (worstSemis <= -2) score += 25;
    else if (worstSemis <= -1) score += 15;
    else if (worstSemis <= -0.3) score += 8;
    // Breadth contribution
    if (valid.length) {
      const ratio = advancers / valid.length;
      if (ratio <= 0.2) score += 20;
      else if (ratio <= 0.35) score += 12;
      else if (ratio <= 0.5) score += 6;
    }
    score = Math.max(0, Math.min(100, score));

    const level: MarketPulseResponse["semisRisk"]["level"] =
      score >= 70 ? "EXTREME" : score >= 45 ? "HIGH" : score >= 22 ? "ELEVATED" : "LOW";

    const reason =
      `VIX ${vixLevel ? vixLevel.toFixed(1) : "—"} · SOXX ${soxxPct >= 0 ? "+" : ""}${soxxPct.toFixed(2)}% · ` +
      `SMH ${smhPct >= 0 ? "+" : ""}${smhPct.toFixed(2)}% · semis basket avg ${semisPct >= 0 ? "+" : ""}${semisPct.toFixed(2)}% ` +
      `(${advancers}↑ / ${decliners}↓ of ${valid.length})`;

    return {
      futures,
      vix,
      semisEtfs: [soxx, smh],
      semisBreadth: { advancers, decliners, unchanged, avgChangePct, components: basket },
      semisRisk: { level, score, reason },
      asOf: Date.now(),
    };
  } catch (error) {
    console.error("[market-pulse] snapshot failed", error);
    return {
      futures: [],
      vix: null,
      semisEtfs: [],
      semisBreadth: { advancers: 0, decliners: 0, unchanged: 0, avgChangePct: null, components: [] },
      semisRisk: { level: "LOW", score: 0, reason: "unavailable" },
      asOf: Date.now(),
      error: "SERVICE_UNAVAILABLE",
    };
  }
}

function computeSemisRisk(
  vixLevel: number,
  soxxPct: number,
  smhPct: number,
  basket: QuoteSnap[],
) {
  const valid = basket.filter((b) => b.changePct != null) as Array<QuoteSnap & { changePct: number }>;
  const advancers = valid.filter((b) => b.changePct > 0.1).length;
  const decliners = valid.filter((b) => b.changePct < -0.1).length;
  const unchanged = valid.length - advancers - decliners;
  const avgChangePct = valid.length ? valid.reduce((s, b) => s + b.changePct, 0) / valid.length : null;
  const semisPct = avgChangePct ?? 0;

  let score = 0;
  if (vixLevel >= 30) score += 40;
  else if (vixLevel >= 22) score += 28;
  else if (vixLevel >= 18) score += 18;
  else if (vixLevel >= 14) score += 8;
  const worstSemis = Math.min(soxxPct, smhPct, semisPct);
  if (worstSemis <= -3) score += 35;
  else if (worstSemis <= -2) score += 25;
  else if (worstSemis <= -1) score += 15;
  else if (worstSemis <= -0.3) score += 8;
  if (valid.length) {
    const ratio = advancers / valid.length;
    if (ratio <= 0.2) score += 20;
    else if (ratio <= 0.35) score += 12;
    else if (ratio <= 0.5) score += 6;
  }
  score = Math.max(0, Math.min(100, score));
  const level: MarketPulseResponse["semisRisk"]["level"] =
    score >= 70 ? "EXTREME" : score >= 45 ? "HIGH" : score >= 22 ? "ELEVATED" : "LOW";
  const reason =
    `VIX ${vixLevel ? vixLevel.toFixed(1) : "—"} · SOXX ${soxxPct >= 0 ? "+" : ""}${soxxPct.toFixed(2)}% · ` +
    `SMH ${smhPct >= 0 ? "+" : ""}${smhPct.toFixed(2)}% · semis basket avg ${semisPct >= 0 ? "+" : ""}${semisPct.toFixed(2)}% ` +
    `(${advancers}↑ / ${decliners}↓ of ${valid.length})`;
  return { advancers, decliners, unchanged, avgChangePct, level, score, reason };
}

// Fast lane: futures + VIX only (5 symbols). Safe to poll every ~2s.
export async function fetchFastPulseSnapshot(): Promise<FastPulseResponse> {
  try {
    const [futures, vix] = await Promise.all([
      Promise.all(US_FUTURES.map((f) => snapFast(f.symbol, f.name))),
      snapFast("^VIX", "VIX"),
    ]);
    return { futures, vix, asOf: Date.now() };
  } catch (error) {
    console.error("[fast-pulse] snapshot failed", error);
    return { futures: [], vix: null, asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
}

// Semis lane: SOXX + SMH + 12-name basket (14 symbols). Poll ~3-4s.
// Needs current VIX for the risk score; reads cheap VIX snap too (~15 symbols).
export async function fetchSemisPulseSnapshot(): Promise<SemisPulseResponse> {
  try {
    const [vix, soxx, smh, basket] = await Promise.all([
      snap("^VIX", "VIX"),
      snap("SOXX", "SOXX"),
      snap("SMH", "SMH"),
      Promise.all(SEMIS_BASKET.map((s) => snap(s.symbol, s.name))),
    ]);
    const r = computeSemisRisk(vix.price ?? 0, soxx.changePct ?? 0, smh.changePct ?? 0, basket);
    return {
      semisEtfs: [soxx, smh],
      semisBreadth: {
        advancers: r.advancers,
        decliners: r.decliners,
        unchanged: r.unchanged,
        avgChangePct: r.avgChangePct,
        components: basket,
      },
      semisRisk: { level: r.level, score: r.score, reason: r.reason },
      asOf: Date.now(),
    };
  } catch (error) {
    console.error("[semis-pulse] snapshot failed", error);
    return {
      semisEtfs: [],
      semisBreadth: { advancers: 0, decliners: 0, unchanged: 0, avgChangePct: null, components: [] },
      semisRisk: { level: "LOW", score: 0, reason: "unavailable" },
      asOf: Date.now(),
      error: "SERVICE_UNAVAILABLE",
    };
  }
}

export async function fetchGlobalSemiIndexSnapshot(): Promise<GlobalSemiIndexResponse> {
  try {
    const components: GlobalSemiComponent[] = await Promise.all(
      GLOBAL_SEMI_INDICES.map(async (idx) => {
        const { price, prev } = await fetchYahooSnap(idx.symbol);
        const changePct = price != null && prev != null && prev > 0 ? ((price - prev) / prev) * 100 : null;
        return { symbol: idx.symbol, name: idx.name, changePct };
      }),
    );
    const valid = components.filter((c) => c.changePct != null) as Array<GlobalSemiComponent & { changePct: number }>;
    const avgChangePct = valid.length ? valid.reduce((s, c) => s + c.changePct, 0) / valid.length : null;
    // Risk model: heavier weight to PHLX Semi (^SOX) since it's the US semi tape.
    // Otherwise a decliner-weighted aggregate of the six Asian/Philly indices.
    const decliners = valid.filter((c) => c.changePct < -0.1).length;
    const sox = valid.find((c) => c.symbol === "^SOX")?.changePct ?? 0;
    const weighted = valid.length
      ? (avgChangePct! * 0.6) + (sox * 0.4)
      : 0;
    // Negative weighted % => higher risk. -2% => ~80, -1% => ~60, 0 => 40, +1% => 20.
    let score = Math.round(40 - weighted * 20 + (decliners >= 4 ? 15 : decliners >= 3 ? 8 : 0));
    score = Math.max(0, Math.min(100, score));
    const level: GlobalSemiIndexResponse["level"] =
      score >= 70 ? "EXTREME" : score >= 50 ? "HIGH" : score >= 30 ? "ELEVATED" : "LOW";
    const fmt = (n: number) => `${n >= 0 ? "+" : ""}${n.toFixed(2)}%`;
    const reason =
      `Asian/Philly semi tape: ` +
      components.map((c) => `${c.name} ${c.changePct == null ? "—" : fmt(c.changePct)}`).join(" · ") +
      `\nAvg ${avgChangePct == null ? "—" : fmt(avgChangePct)} · ${decliners} of ${valid.length} declining`;
    return { avgChangePct, components, level, score, reason, asOf: Date.now() };
  } catch (error) {
    console.error("[global-semis] snapshot failed", error);
    return { avgChangePct: null, components: [], level: "ELEVATED", score: 40, reason: "unavailable", asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
}

const BULLISH_KW = ["beat", "surge", "upgrade", "record", "strong", "growth", "rally", "soar", "boom", "outperform"];
const BEARISH_KW = ["cut", "miss", "downgrade", "tariff", "ban", "glut", "weak", "oversupply", "warning", "plunge", "slump", "layoff"];

export async function fetchSemiRiskSentimentSnapshot(): Promise<SemiRiskSentimentResponse> {
  try {
    const queries = ["semiconductor industry", "chip stocks", "semiconductor demand"];
    const all: { title: string; publisher: string; link: string; publishedAt: number }[] = [];
    for (const q of queries) {
      try {
        const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(q)}&newsCount=10&quotesCount=0`;
        const res = await fetch(url, { headers: { "User-Agent": UA } });
        if (!res.ok) continue;
        const json = (await res.json()) as { news?: Array<{ title?: string; publisher?: string; link?: string; providerPublishTime?: number }> };
        for (const n of json.news ?? []) {
          if (!n.title || !n.link) continue;
          all.push({ title: n.title, publisher: n.publisher ?? "", link: n.link, publishedAt: n.providerPublishTime ?? 0 });
        }
      } catch { /* skip */ }
    }
    // Dedupe by title and sort by recency, take top 5
    const seen = new Set<string>();
    const uniq = all.filter((h) => {
      const k = h.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    uniq.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
    const top = uniq.slice(0, 5);

    let bullish = 0, bearish = 0;
    for (const h of top) {
      const t = h.title.toLowerCase();
      for (const k of BULLISH_KW) if (t.includes(k)) bullish++;
      for (const k of BEARISH_KW) if (t.includes(k)) bearish++;
    }
    // Score 0-100, 50 neutral. More bearish => higher risk.
    const total = bullish + bearish;
    let score = 50;
    if (total > 0) {
      const bearShare = bearish / total;
      score = Math.round(50 + (bearShare - 0.5) * 100);
    }
    score = Math.max(0, Math.min(100, score));
    const level: SemiRiskSentimentResponse["level"] =
      score >= 71 ? "EXTREME" : score >= 51 ? "HIGH" : score >= 31 ? "ELEVATED" : "LOW";
    return {
      level,
      score,
      bullishCount: bullish,
      bearishCount: bearish,
      headlines: top.map((h) => ({ title: h.title, publisher: h.publisher, link: h.link })),
      asOf: Date.now(),
    };
  } catch (error) {
    console.error("[semi-risk-sentiment] snapshot failed", error);
    return {
      level: "ELEVATED", score: 50, bullishCount: 0, bearishCount: 0, headlines: [], asOf: Date.now(), error: "SERVICE_UNAVAILABLE",
    };
  }
}
