import { createFileRoute } from "@tanstack/react-router";
import { timingSafeEqual } from "node:crypto";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";

type AlertState = {
  symbol: string;
  last_price_alert_bucket: string | null;
  last_news_pubdate: string | null;
  last_news_guid: string | null;
};

async function sendPushover(title: string, message: string, url?: string) {
  const token = process.env.PUSHOVER_APP_TOKEN;
  const user = process.env.PUSHOVER_USER_KEY;
  if (!token || !user) throw new Error("Pushover secrets not configured");
  const body = new URLSearchParams({
    token,
    user,
    title: title.slice(0, 250),
    message: message.slice(0, 1024),
  });
  if (url) {
    body.set("url", url);
    body.set("url_title", "Open");
  }
  const res = await fetch("https://api.pushover.net/1/messages.json", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error("[pushover] send failed", res.status, text);
  }
  return res.ok;
}

async function fetchQuote(symbol: string): Promise<{
  price: number;
  prevClose: number;
  changePct: number;
} | null> {
  try {
    const r = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?interval=5m&range=1d`,
      { headers: { "User-Agent": UA, Accept: "application/json" } },
    );
    if (!r.ok) return null;
    const j: any = await r.json();
    const meta = j?.chart?.result?.[0]?.meta;
    const price = Number(meta?.regularMarketPrice);
    const prev = Number(meta?.chartPreviousClose ?? meta?.previousClose);
    if (!Number.isFinite(price) || !Number.isFinite(prev) || prev <= 0) return null;
    return { price, prevClose: prev, changePct: ((price - prev) / prev) * 100 };
  } catch {
    return null;
  }
}

type NewsItem = { title: string; link: string; guid: string; pubDate: string };

async function fetchNews(symbol: string): Promise<NewsItem[]> {
  try {
    const r = await fetch(
      `https://feeds.finance.yahoo.com/rss/2.0/headline?s=${encodeURIComponent(symbol)}&region=US&lang=en-US`,
      { headers: { "User-Agent": UA, Accept: "application/rss+xml,*/*" } },
    );
    if (!r.ok) return [];
    const xml = await r.text();
    const items: NewsItem[] = [];
    const itemRe = /<item>([\s\S]*?)<\/item>/g;
    let m: RegExpExecArray | null;
    while ((m = itemRe.exec(xml)) && items.length < 5) {
      const block = m[1];
      const get = (tag: string) => {
        const re = new RegExp(`<${tag}(?:[^>]*)>([\\s\\S]*?)<\\/${tag}>`);
        const mm = re.exec(block);
        if (!mm) return "";
        return mm[1].replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1").trim();
      };
      items.push({
        title: get("title"),
        link: get("link"),
        guid: get("guid"),
        pubDate: get("pubDate"),
      });
    }
    return items;
  } catch {
    return [];
  }
}

function bucketFor(pct: number): string | null {
  const abs = Math.abs(pct);
  if (abs < 5) return null;
  // Bucket in 5% increments + sign + UTC date (so we re-alert on the next day).
  const day = new Date().toISOString().slice(0, 10);
  const step = Math.floor(abs / 5) * 5;
  const sign = pct >= 0 ? "+" : "-";
  return `${day}:${sign}${step}`;
}

function requireWebhookSecret(request: Request): Response | null {
  const secret = process.env.PUSHOVER_WEBHOOK_SECRET;
  if (!secret) return new Response("Unauthorized", { status: 401 });
  const provided =
    request.headers.get("x-webhook-secret") ??
    request.headers.get("authorization")?.replace(/^Bearer\s+/i, "") ??
    new URL(request.url).searchParams.get("secret") ??
    "";
  const a = Buffer.from(provided);
  const b = Buffer.from(secret);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return new Response("Unauthorized", { status: 401 });
  }
  return null;
}

async function runAlerts() {
  const { supabaseAdmin } = await import("@/integrations/supabase/client.server");
  // Collect first 20 unique symbols across all user watchlists (deterministic order).
  const { data: lists, error } = await supabaseAdmin
    .from("watchlists")
    .select("symbols")
    .order("updated_at", { ascending: false });
  if (error) throw new Error(error.message);

  const seen = new Set<string>();
  const symbols: string[] = [];
  for (const row of lists ?? []) {
    const syms = (row as { symbols: string[] }).symbols ?? [];
    for (const s of syms) {
      const sym = String(s).toUpperCase();
      if (!sym || seen.has(sym)) continue;
      seen.add(sym);
      symbols.push(sym);
      if (symbols.length >= 20) break;
    }
    if (symbols.length >= 20) break;
  }

  if (symbols.length === 0) return { checked: 0, alerts: 0 };

  const { data: stateRows } = await supabaseAdmin
    .from("pushover_alert_state")
    .select("symbol,last_price_alert_bucket,last_news_pubdate,last_news_guid")
    .in("symbol", symbols);
  const stateMap = new Map<string, AlertState>();
  for (const s of (stateRows ?? []) as AlertState[]) stateMap.set(s.symbol, s);

  let alerts = 0;

  await Promise.all(
    symbols.map(async (sym) => {
      const st = stateMap.get(sym) ?? {
        symbol: sym,
        last_price_alert_bucket: null,
        last_news_pubdate: null,
        last_news_guid: null,
      };
      const updates: Partial<AlertState> = {};

      // --- Price move ≥5% ---
      const quote = await fetchQuote(sym);
      if (quote) {
        const bucket = bucketFor(quote.changePct);
        if (bucket && bucket !== st.last_price_alert_bucket) {
          const dir = quote.changePct >= 0 ? "▲" : "▼";
          await sendPushover(
            `${dir} ${sym} ${quote.changePct.toFixed(2)}%`,
            `Price $${quote.price.toFixed(2)} (prev close $${quote.prevClose.toFixed(2)})`,
            `https://finance.yahoo.com/quote/${encodeURIComponent(sym)}`,
          );
          alerts++;
          updates.last_price_alert_bucket = bucket;
        }
      }

      // --- News ---
      const news = await fetchNews(sym);
      if (news.length > 0) {
        const lastPub = st.last_news_pubdate ? Date.parse(st.last_news_pubdate) : 0;
        const lastGuid = st.last_news_guid ?? "";
        // RSS is newest-first
        const fresh = news.filter((n) => {
          const t = n.pubDate ? Date.parse(n.pubDate) : 0;
          if (!t) return false;
          if (n.guid && n.guid === lastGuid) return false;
          return t > lastPub;
        });
        // Cap at 2 most recent so we don't blast a backlog on first run
        const toSend = lastPub === 0 ? fresh.slice(0, 1) : fresh.slice(0, 2);
        for (const n of toSend.reverse()) {
          await sendPushover(`📰 ${sym}`, n.title, n.link);
          alerts++;
        }
        const newest = news[0];
        if (newest?.pubDate) updates.last_news_pubdate = new Date(newest.pubDate).toISOString();
        if (newest?.guid) updates.last_news_guid = newest.guid;
      }

      if (Object.keys(updates).length > 0) {
        await supabaseAdmin
          .from("pushover_alert_state")
          .upsert({ symbol: sym, ...updates, updated_at: new Date().toISOString() });
      }
    }),
  );

  return { checked: symbols.length, alerts, symbols };
}

export const Route = createFileRoute("/api/public/hooks/pushover-alerts")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const unauth = requireWebhookSecret(request);
        if (unauth) return unauth;
        try {
          const result = await runAlerts();
          return new Response(JSON.stringify({ ok: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: any) {
          console.error("[pushover-alerts] error", e);
          return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
      GET: async ({ request }) => {
        const unauth = requireWebhookSecret(request);
        if (unauth) return unauth;
        try {
          const result = await runAlerts();
          return new Response(JSON.stringify({ ok: true, ...result }), {
            headers: { "Content-Type": "application/json" },
          });
        } catch (e: any) {
          return new Response(JSON.stringify({ ok: false, error: String(e?.message ?? e) }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          });
        }
      },
    },
  },
});