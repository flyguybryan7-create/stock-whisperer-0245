import { createServerFn } from "@tanstack/react-start";

const UA = "Mozilla/5.0 (compatible; BryanTrade/1.0)";

// Asia-listed semiconductor leaders (Yahoo symbols).
const ASIA_SEMIS: { symbol: string; name: string }[] = [
  { symbol: "2330.TW", name: "TSMC" },
  { symbol: "005930.KS", name: "Samsung" },
  { symbol: "000660.KS", name: "SK Hynix" },
  { symbol: "8035.T", name: "Tokyo Electron" },
  { symbol: "6857.T", name: "Advantest" },
];

type Component = { symbol: string; name: string; changePct: number | null };

async function fetchOne(symbol: string): Promise<number | null> {
  // Try query1 then query2 (one is sometimes blocked).
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const r = await fetch(
        `https://${host}/v8/finance/chart/${encodeURIComponent(symbol)}?interval=1d&range=5d`,
        { headers: { "User-Agent": UA, Accept: "application/json" } },
      );
      if (!r.ok) {
        console.error("[asia-semis] fetch failed", symbol, host, r.status);
        continue;
      }
      const j: any = await r.json();
      const meta = j?.chart?.result?.[0]?.meta;
      const price = Number(meta?.regularMarketPrice);
      const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
      if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) continue;
      return ((price - prev) / prev) * 100;
    } catch (e) {
      console.error("[asia-semis] error", symbol, host, e);
    }
  }
  return null;
}

export const fetchAsiaSemis = createServerFn({ method: "GET" }).handler(async () => {
  const components: Component[] = await Promise.all(
    ASIA_SEMIS.map(async (s) => ({ ...s, changePct: await fetchOne(s.symbol) })),
  );
  const valid = components.filter((c) => c.changePct != null) as Array<Component & { changePct: number }>;
  const avg = valid.length ? valid.reduce((sum, c) => sum + c.changePct, 0) / valid.length : null;
  return { avgChangePct: avg, components, asOf: Date.now() };
});

type NewsItem = { title: string; link: string; publisher: string; publishedAt: number | null };

const FEEDS: { url: string; publisher: string }[] = [
  { url: "https://www.cnbc.com/id/100003114/device/rss/rss.html", publisher: "CNBC" },
  { url: "https://feeds.content.dowjones.io/public/rss/mw_topstories", publisher: "MarketWatch" },
  { url: "https://feeds.content.dowjones.io/public/rss/RSSMarketsMain", publisher: "WSJ Markets" },
];

function parseRss(xml: string, publisher: string): NewsItem[] {
  const items: NewsItem[] = [];
  const itemRe = /<item[\s\S]*?>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && items.length < 20) {
    const block = m[1];
    const get = (tag: string) => {
      const re = new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`);
      const mm = re.exec(block);
      if (!mm) return "";
      return mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    };
    const pub = get("pubDate");
    const t = pub ? Date.parse(pub) : NaN;
    items.push({
      title: get("title"),
      link: get("link"),
      publisher,
      publishedAt: Number.isFinite(t) ? Math.floor(t / 1000) : null,
    });
  }
  return items;
}

// Keywords that flag a story as likely market-moving for US indices.
const MARKET_KEYWORDS = [
  "fed", "federal reserve", "powell", "fomc", "rate", "inflation", "cpi", "ppi", "jobs",
  "payroll", "unemployment", "gdp", "treasury", "yield", "bond", "tariff", "trade", "china",
  "oil", "opec", "earnings", "nasdaq", "s&p", "dow", "stock", "market", "recession",
  "semiconductor", "chip", "nvidia", "apple", "microsoft", "tesla", "ai",
];

function isMarketImpacting(title: string): boolean {
  const t = title.toLowerCase();
  return MARKET_KEYWORDS.some((k) => t.includes(k));
}

export const fetchMacroNews = createServerFn({ method: "GET" }).handler(async () => {
  const lists = await Promise.all(
    FEEDS.map(async (f) => {
      try {
        const r = await fetch(f.url, {
          headers: { "User-Agent": UA, Accept: "application/rss+xml,*/*" },
        });
        if (!r.ok) return [] as NewsItem[];
        const xml = await r.text();
        return parseRss(xml, f.publisher);
      } catch {
        return [] as NewsItem[];
      }
    }),
  );
  const all = lists.flat().filter((n) => n.title && isMarketImpacting(n.title));
  // De-dupe by title.
  const seen = new Set<string>();
  const deduped: NewsItem[] = [];
  for (const n of all) {
    const key = n.title.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(n);
  }
  deduped.sort((a, b) => (b.publishedAt ?? 0) - (a.publishedAt ?? 0));
  return { items: deduped.slice(0, 15), asOf: Date.now() };
});