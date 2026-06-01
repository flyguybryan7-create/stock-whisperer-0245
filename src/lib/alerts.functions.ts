import { createServerFn } from "@tanstack/react-start";

// In-memory cooldown so we don't spam the phone. 5 min per symbol+signal.
const lastSent = new Map<string, number>();
const COOLDOWN_MS = 5 * 60 * 1000;

export const sendSmsAlert = createServerFn({ method: "POST" })
  .inputValidator((input: {
    phone: string;
    carrier: string; // "tmobile" | "att" | "verizon" | "sprint"
    symbol: string;
    signal: "BUY" | "SELL";
    price: number;
    reason?: string;
  }) => {
    const phone = String(input.phone || "").replace(/\D/g, "").slice(-10);
    if (phone.length !== 10) throw new Error("invalid phone");
    const carrier = String(input.carrier || "tmobile").toLowerCase();
    const symbol = String(input.symbol || "").toUpperCase().slice(0, 10);
    const signal = input.signal === "SELL" ? "SELL" : "BUY";
    const price = Number(input.price);
    if (!Number.isFinite(price)) throw new Error("invalid price");
    return {
      phone,
      carrier,
      symbol,
      signal,
      price,
      reason: String(input.reason || "").slice(0, 160),
    };
  })
  .handler(async ({ data }) => {
    const apiKey = process.env.LOVABLE_API_KEY;
    const resendKey = process.env.RESEND_API_KEY;
    if (!apiKey) return { ok: false, error: "LOVABLE_API_KEY missing" };
    if (!resendKey) return { ok: false, error: "RESEND_API_KEY missing" };

    const cooldownKey = `${data.phone}:${data.symbol}:${data.signal}`;
    const now = Date.now();
    const prev = lastSent.get(cooldownKey) ?? 0;
    if (now - prev < COOLDOWN_MS) {
      return { ok: false, error: "cooldown", remainingMs: COOLDOWN_MS - (now - prev) };
    }

    const gateways: Record<string, string> = {
      tmobile: "tmomail.net",
      att: "txt.att.net",
      verizon: "vtext.com",
      sprint: "messaging.sprintpcs.com",
    };
    const domain = gateways[data.carrier] ?? "tmomail.net";
    const to = `${data.phone}@${domain}`;

    const subject = `${data.signal} ${data.symbol} @ $${data.price.toFixed(2)}`;
    const text = `${data.signal} ${data.symbol} $${data.price.toFixed(2)}${data.reason ? ` — ${data.reason}` : ""}`;

    try {
      const res = await fetch("https://connector-gateway.lovable.dev/resend/emails", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${apiKey}`,
          "X-Connection-Api-Key": resendKey,
        },
        body: JSON.stringify({
          from: "BryanTrade <onboarding@resend.dev>",
          to: [to],
          subject,
          text,
        }),
      });
      if (!res.ok) {
        const body = await res.text();
        return { ok: false, error: `resend ${res.status}: ${body.slice(0, 200)}` };
      }
      lastSent.set(cooldownKey, now);
      return { ok: true, to };
    } catch (err) {
      return { ok: false, error: (err as Error).message };
    }
  });