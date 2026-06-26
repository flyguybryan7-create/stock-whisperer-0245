# Build Plan

Three independent pieces. I'll ship them in this order so each one is testable on its own.

## 1. Shared Schwab token (fixes stale quotes for shared viewers)

Today your Schwab tokens live in browser cookies — only *you* have them. Viewers fall back to Yahoo. To use your token as a shared feed:

- New table `schwab_owner_tokens` (single-row, owner-only) holding `access_token`, `refresh_token`, `expires_at`, `obtained_at`. RLS: only your `user_id` can read/write; service role for the refresher.
- New server fn `setOwnerSchwabTokens` — called once after *you* sign into Schwab; stores tokens in the table.
- New server fn `getSharedSchwabQuotes(symbols)` — public (no auth). Server-side it loads the owner's token from the table using `supabaseAdmin`, auto-refreshes if expired (uses existing `refreshSchwabToken`), then calls Schwab quotes. Returns the same shape as `getSchwabQuotes`.
- Client switches `schwabQuotes` polling from per-user `getSchwabQuotes` to `getSharedSchwabQuotes` so every visitor on every device sees live Schwab quotes at 1s cadence.
- Same swap for `getSchwabFundamentals` → `getSharedSchwabFundamentals` and `getSchwabTopStrikes` → `getSharedSchwabTopStrikes`.

**Tradeoff you accepted:** uses your account's rate limits and is against Schwab ToS. If Schwab notices and revokes, only the shared-quote path breaks — your per-user OAuth still works.

## 2. Schwab WebSocket streamer

Schwab's streamer needs a per-account login handshake (userid + token + channel). The clean architecture:

- Server route `/api/public/schwab-stream` (SSE, not WS — Cloudflare Workers don't support persistent outbound WS on the free tier reliably). 
- On first connect, server opens a single Schwab streamer WS using the owner's token (same shared-feed model as #1), subscribes to LEVELONE_EQUITIES for the union of all symbols any viewer has requested in the last 60s.
- Server fans out ticks to every connected SSE client filtered by their symbol list.
- Client hook `useSchwabStream(symbols)` opens an EventSource, merges ticks into the same `live` state your `LiveQuote` map already uses.
- Polling stays as fallback if the stream drops.

**Honest caveat:** Cloudflare Workers cap WS connection lifetime (~30s idle, ~5min hard). I'll add auto-reconnect, but a true always-on streamer ideally runs on a long-lived server. This will work but expect occasional reconnects. If reconnects become a problem we move the streamer to a small Node worker on Fly/Render later.

## 3. Gap-Trap indicator

Per symbol on each tick, compute from existing 2m intraday bars (already in `intradayBars`):

```text
gapPct  = (todayOpen - yesterdayClose) / yesterdayClose
vwap    = session VWAP (already have from Schwab)
firstHr = first 30min after 9:30 ET
rejection = high(firstHr) > todayOpen * 1.005 AND
            currentClose < vwap AND
            currentClose < todayOpen AND
            volume(firstHr) > 1.5 * avgVol(first30m, 20d)
```

- `gapPct > +3%` AND `rejection` → **🪤 GAP TRAP (bull trap)** — red pulsing badge
- `gapPct < -3%` AND inverse rejection → **🪤 GAP TRAP (bear trap)** — green pulsing badge
- Otherwise hidden.

Renders in the symbol header next to the price, pulses for 5min after first trigger, then becomes a static badge for the rest of the session. Hover shows the trigger reason.

I'll also wire it into the watchlist row so you can see at a glance which names are trapped.

## Files

- `supabase/migrations/<ts>_schwab_owner_tokens.sql` — new table + RLS + grants
- `src/lib/schwab-shared.functions.ts` — new shared-feed server fns + token refresher
- `src/lib/schwab.functions.ts` — add `setOwnerSchwabTokens`
- `src/routes/api/public/schwab-stream.ts` — new SSE route
- `src/lib/schwab-stream.client.ts` — new `useSchwabStream` hook
- `src/lib/trap-indicator.ts` — pure detection function
- `src/components/TradingPlatform.tsx` — swap quote sources, add stream hook, render trap badges

## Out of scope (per your answer)

- 24h overnight bars — holding until you find an overnight-session feed.

Ready for me to build?
