import { createServerFn } from "@tanstack/react-start";

/**
 * Lightweight economic-data feed for chart 'E' markers.
 * Sources (all public, no key required):
 *   - Federal Reserve press releases (FOMC, monetary policy, minutes)
 *   - BLS news releases (CPI, PPI, NFP/Employment Situation, JOLTS)
 *   - BEA news (GDP, PCE, personal income)
 *   - Treasury press
 */

export type EconEvent = {
  title: string;
  publisher: string;
  link: string;
  publishedAt: number; // unix seconds
  category: "FED" | "CPI" | "PCE" | "JOBS" | "GDP" | "PPI" | "RETAIL" | "TREASURY" | "OTHER";
};

export type EconCalendarResponse = { items: EconEvent[]; asOf: number; error?: string };

const UA = "Mozilla/5.0 (compatible; BryanTrade/1.0)";

const FEEDS: { url: string; publisher: string }[] = [
  { url: "https://www.federalreserve.gov/feeds/press_all.xml", publisher: "Federal Reserve" },
  { url: "https://www.bls.gov/feed/news_release/main.rss", publisher: "BLS" },
  { url: "https://www.bea.gov/rss.xml", publisher: "BEA" },
  { url: "https://home.treasury.gov/rss/press/all.xml", publisher: "Treasury" },
];

const HIGH_IMPACT = [
  { rx: /\b(cpi|consumer price)\b/i, cat: "CPI" as const },
  { rx: /\b(ppi|producer price)\b/i, cat: "PPI" as const },
  { rx: /\b(pce|personal income|personal consumption)\b/i, cat: "PCE" as const },
  { rx: /\b(employment situation|nonfarm|payroll|jobs report|unemployment)\b/i, cat: "JOBS" as const },
  { rx: /\b(gdp|gross domestic product)\b/i, cat: "GDP" as const },
  { rx: /\b(retail sales)\b/i, cat: "RETAIL" as const },
  { rx: /\b(fomc|federal open market|monetary policy|rate decision|beige book|powell)\b/i, cat: "FED" as const },
];

function parseRss(xml: string, publisher: string): EconEvent[] {
  const items: EconEvent[] = [];
  const itemRe = /<item[\s\S]*?>([\s\S]*?)<\/item>/g;
  let m: RegExpExecArray | null;
  while ((m = itemRe.exec(xml)) && items.length < 40) {
    const block = m[1];
    const get = (tag: string) => {
      const re = new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`);
      const im = re.exec(block);
      if (!im) return "";
      return im[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
    };
    const title = get("title");
    if (!title) continue;
    const match = HIGH_IMPACT.find((h) => h.rx.test(title));
    if (!match) continue;
    const pubDate = get("pubDate") || get("dc:date");
    const ts = pubDate ? Date.parse(pubDate) : NaN;
    if (!Number.isFinite(ts)) continue;
    items.push({
      title, publisher, link: get("link"),
      publishedAt: Math.floor(ts / 1000),
      category: match.cat,
    });
  }
  return items;
}

export const fetchEconCalendar = createServerFn({ method: "GET" }).handler(async (): Promise<EconCalendarResponse> => {
  try {
    const lists = await Promise.all(FEEDS.map(async (f) => {
      try {
        const res = await fetch(f.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,*/*" } });
        if (!res.ok) return [] as EconEvent[];
        return parseRss(await res.text(), f.publisher);
      } catch { return [] as EconEvent[]; }
    }));
    const all = lists.flat();
    const seen = new Set<string>();
    const uniq = all.filter((i) => {
      const k = i.title.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    uniq.sort((a, b) => b.publishedAt - a.publishedAt);
    return { items: uniq.slice(0, 40), asOf: Date.now() };
  } catch (error) {
    console.error("[econ-calendar] failed", error);
    return { items: [], asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
});