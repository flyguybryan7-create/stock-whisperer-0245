import { createServerFn } from "@tanstack/react-start";
import { supabaseAdmin } from "@/integrations/supabase/client.server";
import { sendWebPush, type PushSubscriptionRow } from "./push.server";

// 5-minute per-symbol+signal cooldown so we don't spam devices.
const lastSent = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000;

export const subscribeToPush = createServerFn({ method: "POST" })
  .inputValidator((d: {
    endpoint: string;
    p256dh: string;
    auth: string;
    userAgent?: string;
  }) => d)
  .handler(async ({ data }) => {
    if (!data.endpoint || !data.p256dh || !data.auth) {
      throw new Error("missing subscription fields");
    }
    const { error } = await supabaseAdmin
      .from("push_subscriptions")
      .upsert(
        {
          endpoint: data.endpoint,
          p256dh: data.p256dh,
          auth: data.auth,
          user_agent: data.userAgent ?? null,
        },
        { onConflict: "endpoint" },
      );
    if (error) throw new Error(error.message);
    return { ok: true };
  });

export const unsubscribeFromPush = createServerFn({ method: "POST" })
  .inputValidator((d: { endpoint: string }) => d)
  .handler(async ({ data }) => {
    const { error } = await supabaseAdmin
      .from("push_subscriptions")
      .delete()
      .eq("endpoint", data.endpoint);
    if (error) throw new Error(error.message);
    return { ok: true };
  });

async function broadcast(payload: {
  title: string;
  body: string;
  url?: string;
  tag?: string;
}) {
  const { data: subs, error } = await supabaseAdmin
    .from("push_subscriptions")
    .select("endpoint, p256dh, auth");
  if (error) throw new Error(error.message);
  if (!subs || subs.length === 0) return { sent: 0, pruned: 0 };

  const json = JSON.stringify(payload);
  const results = await Promise.allSettled(
    subs.map((s: PushSubscriptionRow) => sendWebPush(s, json)),
  );

  const gone: string[] = [];
  let sent = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      if (r.value.ok) sent++;
      else if (r.value.gone) gone.push(r.value.endpoint);
    }
  }
  if (gone.length > 0) {
    await supabaseAdmin.from("push_subscriptions").delete().in("endpoint", gone);
  }
  return { sent, pruned: gone.length, total: subs.length };
}

export const sendAlert = createServerFn({ method: "POST" })
  .inputValidator((d: {
    symbol: string;
    signal: "BUY" | "SELL";
    price: number;
    reason?: string;
  }) => d)
  .handler(async ({ data }) => {
    const symbol = String(data.symbol || "").toUpperCase().slice(0, 10);
    const signal = data.signal === "SELL" ? "SELL" : "BUY";
    const price = Number(data.price);
    if (!symbol || !Number.isFinite(price)) throw new Error("invalid input");

    const key = `${symbol}:${signal}`;
    const now = Date.now();
    const prev = lastSent.get(key) ?? 0;
    if (now - prev < COOLDOWN_MS) {
      return { ok: false, error: "cooldown", remainingMs: COOLDOWN_MS - (now - prev) };
    }
    lastSent.set(key, now);

    const result = await broadcast({
      title: `${signal} ${symbol} @ $${price.toFixed(2)}`,
      body: data.reason ? data.reason.slice(0, 140) : `Auto signal: ${signal} ${symbol}`,
      url: "/",
      tag: key,
    });
    return { ok: true, ...result };
  });

export const sendTestPush = createServerFn({ method: "POST" }).handler(async () => {
  const result = await broadcast({
    title: "BryanTrade test alert",
    body: "Push notifications are working 🎉",
    url: "/",
    tag: "test",
  });
  return { ok: true, ...result };
});