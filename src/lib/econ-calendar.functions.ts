import { createServerFn } from "@tanstack/react-start";

/**
 * Lightweight economic-data feed for chart 'E' markers.
 * Sources (all public, no key required):
 *   - Nasdaq economic calendar API (US high-impact prints incl. NFP, CPI,
 *     PCE, GDP, ISM, JOLTS, Retail Sales, Fed decisions) — this is the only
 *     source with intraday-accurate release timestamps for jobs data.
 *   - Federal Reserve press releases (FOMC minutes, Powell speeches).
 *   - BEA news RSS (personal income / PCE, GDP) — real timestamp back-up.
 */

export type EconEvent = {
  title: string;
  publisher: string;
  link: string;
  publishedAt: number; // unix seconds
  category: "FED" | "CPI" | "PCE" | "JOBS" | "GDP" | "PPI" | "RETAIL" | "ISM" | "JOLTS" | "TREASURY" | "OTHER";
};

export type EconCalendarResponse = { items: EconEvent[]; asOf: number; error?: string };

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

const FEEDS: { url: string; publisher: string }[] = [
  { url: "https://www.federalreserve.gov/feeds/press_all.xml", publisher: "Federal Reserve" },
  { url: "https://apps.bea.gov/rss/rss.xml", publisher: "BEA" },
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

// Nasdaq calendar event-name → category (US-only). These are the prints that
// consistently move US equities intraday. Order matters — first match wins.
const NASDAQ_HIGH_IMPACT: Array<{ rx: RegExp; cat: EconEvent["category"] }> = [
  { rx: /\b(nonfarm payrolls|unemployment rate|average hourly earnings|participation rate|employment situation)\b/i, cat: "JOBS" },
  { rx: /\b(jolts|job openings)\b/i, cat: "JOLTS" },
  { rx: /\b(adp)\b/i, cat: "JOBS" },
  { rx: /\bcore cpi|^cpi\b|consumer price/i, cat: "CPI" },
  { rx: /\bcore ppi|^ppi\b|producer price/i, cat: "PPI" },
  { rx: /\bpce price|core pce|personal income|personal spending/i, cat: "PCE" },
  { rx: /\b(gdp|gross domestic product)\b/i, cat: "GDP" },
  { rx: /\b(retail sales)\b/i, cat: "RETAIL" },
  { rx: /\b(ism|s&p global .* pmi|manufacturing pmi|services pmi)\b/i, cat: "ISM" },
  { rx: /\b(fomc|fed interest rate|fed funds|federal funds|rate decision|powell|beige book|fed chair|monetary policy)\b/i, cat: "FED" },
  { rx: /\b(initial jobless claims|continuing jobless claims)\b/i, cat: "JOBS" },
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

function decodeHtml(s: string): string {
  return s.replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#039;/g, "'").replace(/&nbsp;/g, " ");
}

// Nasdaq returns { data: { rows: [{ gmt, country, eventName, actual, ... }] } }
// for a specific YYYY-MM-DD. We query the last 5 calendar days so we always
// pick up releases (jobs day, CPI day, etc.) that landed within an intraday
// chart's visible window.
async function fetchNasdaqDay(dateISO: string): Promise<EconEvent[]> {
  const url = `https://api.nasdaq.com/api/calendar/economicevents?date=${dateISO}`;
  const res = await fetch(url, {
    headers: {
      "User-Agent": UA,
      Accept: "application/json, text/plain, */*",
      "Accept-Language": "en-US,en;q=0.9",
      Origin: "https://www.nasdaq.com",
      Referer: "https://www.nasdaq.com/",
    },
  });
  if (!res.ok) return [];
  const json: any = await res.json().catch(() => null);
  const rows: any[] = json?.data?.rows ?? [];
  const out: EconEvent[] = [];
  for (const r of rows) {
    if (String(r.country ?? "").toLowerCase() !== "united states") continue;
    const name = decodeHtml(String(r.eventName ?? "").trim());
    if (!name) continue;
    const match = NASDAQ_HIGH_IMPACT.find((h) => h.rx.test(name));
    if (!match) continue;
    // r.gmt is "HH:MM" (24h UTC). Combine with dateISO to get a real UTC ts.
    const gmt = String(r.gmt ?? "").match(/^(\d{1,2}):(\d{2})$/);
    const hh = gmt ? Number(gmt[1]) : 12;
    const mm = gmt ? Number(gmt[2]) : 30;
    const [y, m, d] = dateISO.split("-").map(Number);
    const ts = Date.UTC(y, (m ?? 1) - 1, d ?? 1, hh, mm) / 1000;
    if (!Number.isFinite(ts)) continue;
    out.push({
      title: `${name}${r.actual && String(r.actual).trim() ? ` — ${decodeHtml(String(r.actual).trim())}` : ""}`,
      publisher: "Nasdaq Economic Calendar",
      link: "https://www.nasdaq.com/market-activity/economic-calendar",
      publishedAt: Math.floor(ts),
      category: match.cat,
    });
  }
  return out;
}

export const fetchEconCalendar = createServerFn({ method: "GET" }).handler(async (): Promise<EconCalendarResponse> => {
  try {
    const today = new Date();
    const dates: string[] = [];
    for (let i = 0; i < 5; i++) {
      const d = new Date(today);
      d.setUTCDate(d.getUTCDate() - i);
      dates.push(d.toISOString().slice(0, 10));
    }
    const [nasdaqLists, rssLists] = await Promise.all([
      Promise.all(dates.map((d) => fetchNasdaqDay(d).catch(() => [] as EconEvent[]))),
      Promise.all(FEEDS.map(async (f) => {
        try {
          const res = await fetch(f.url, { headers: { "User-Agent": UA, Accept: "application/rss+xml,*/*" } });
          if (!res.ok) return [] as EconEvent[];
          return parseRss(await res.text(), f.publisher);
        } catch { return [] as EconEvent[]; }
      })),
    ]);
    const all = [...nasdaqLists.flat(), ...rssLists.flat()];
    const seen = new Set<string>();
    const uniq = all.filter((i) => {
      // De-dupe by (category, published day) so BEA/Fed RSS don't repeat the
      // same NFP/PCE row Nasdaq already surfaced.
      const k = `${i.category}|${Math.floor(i.publishedAt / 3600)}|${i.title.toLowerCase()}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
    uniq.sort((a, b) => b.publishedAt - a.publishedAt);
    return { items: uniq.slice(0, 60), asOf: Date.now() };
  } catch (error) {
    console.error("[econ-calendar] failed", error);
    return { items: [], asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
});