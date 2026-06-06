const UA = "Mozilla/5.0 (compatible; BryanTrade/1.0)";

const ASIA_SEMIS: { symbol: string; name: string }[] = [
  { symbol: "2330.TW", name: "TSMC" },
  { symbol: "005930.KS", name: "Samsung" },
  { symbol: "000660.KS", name: "SK Hynix" },
  { symbol: "8035.T", name: "Tokyo Electron" },
  { symbol: "6857.T", name: "Advantest" },
];

export type AsiaSemiComponent = { symbol: string; name: string; changePct: number | null };
export type AsiaSemisResponse = {
  avgChangePct: number | null;
  components: AsiaSemiComponent[];
  asOf: number;
  error?: string;
};

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

async function fetchAsiaSemiChange(symbol: string): Promise<number | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const response = await fetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
        { headers: { "User-Agent": UA, Accept: "application/json" } },
      );

      if (!response.ok) {
        console.error("[asia-semis] fetch failed", symbol, host, response.status);
        continue;
      }

      const json: any = await response.json();
      const meta = json?.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice);
      const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
      if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) continue;
      return ((price - prev) / prev) * 100;
    } catch (error) {
      console.error("[asia-semis] error", symbol, host, error);
    }
  }

  return null;
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