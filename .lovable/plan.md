## Push notifications for BUY/SELL alerts

Replace SMS with web-push notifications that arrive on your iPhone home-screen install (and any other installed device). Free, no carrier dependency.

### How it works
1. You install the app to your iPhone home screen (already done).
2. The app asks "Allow notifications?" once. You tap Allow.
3. Whenever the bot fires a BUY/SELL signal, the server pushes a notification to every subscribed device — even when the app is closed.

### What I'll build

**1. Enable Lovable Cloud** — needed to store push subscriptions (one row per device) so the server knows where to send alerts.

**2. Service worker** (`public/sw.js`)
   - Receives `push` events and displays the notification.
   - Guarded so it never registers inside the Lovable editor preview iframe (prevents stale-cache issues).
   - Kill-switch friendly — no HTML caching, push-only.

**3. VAPID keys** — generated once, stored as Lovable Cloud secrets (`VAPID_PUBLIC_KEY`, `VAPID_PRIVATE_KEY`, `VAPID_SUBJECT`). Public key is exposed to the browser; private key stays server-side.

**4. Database table** `push_subscriptions` (endpoint, p256dh, auth, user_agent, created_at) with RLS.

**5. Server functions** (`src/lib/push.functions.ts`)
   - `subscribeToPush({ subscription })` — inserts row.
   - `unsubscribeFromPush({ endpoint })` — deletes row.
   - `sendAlert({ symbol, action, price, reason })` — signs VAPID JWT with Web Crypto and POSTs to each stored endpoint. Pure-Web-Crypto implementation (no `web-push` npm package — that one assumes Node and breaks in the Worker runtime).

**6. UI** in `TradingPlatform.tsx`
   - New "🔔 Enable alerts" button in the header next to the Schwab button.
   - States: `unsupported` / `default` / `granted` / `denied`.
   - Tapping it requests permission, subscribes via `PushManager`, sends subscription to server.
   - Test button "Send test alert" so you can verify end-to-end.

**7. Wire into existing signal logic** — wherever the bot currently triggers a BUY/SELL (the same spot SMS was called), call `sendAlert(...)` instead.

### Technical notes (skip if not interested)
- iOS 16.4+ supports web push only for **installed PWAs** (already your case).
- VAPID JWT: ES256 over `{aud, exp, sub}`, signed with Web Crypto's `ECDSA P-256`. ~40 lines, no external deps.
- The service worker uses `NetworkFirst` for any HTML route and a denylist for `/~oauth` so it never interferes with the Schwab callback.
- All push sends are fire-and-forget with `Promise.allSettled`; expired endpoints (410/404) are auto-pruned from the table.

### Out of scope (ask if you want any)
- Notification preferences UI (per-symbol mute, quiet hours).
- Rich notifications with chart thumbnails.
- Desktop browser support beyond what Chrome/Edge/Firefox already give for free.
