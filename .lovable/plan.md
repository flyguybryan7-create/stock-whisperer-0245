## What to change

### 1. Day high / day low above 52W H / 52W L
- Extend `LiveQuote` (`src/lib/quotes.functions.ts`) with `dayHigh` and `dayLow`.
- Populate both paths:
  - v7 path: read `regularMarketDayHigh` / `regularMarketDayLow` from the Yahoo v7 response.
  - v8 chart fallback: read `meta.regularMarketDayHigh` / `meta.regularMarketDayLow`; if absent, compute from today's intraday bars (max of `high[]`, min of `low[]` in the regular session window).
- In `TradingPlatform.tsx`, render a new row directly above the 52W H / 52W L row using the same styling:
  - `Day H $xx.xx` (green) and `Day L $xx.xx` (red).
  - Only render when values exist.

### 2. MACD chart cuts off the blue/red lines (ALAB)
The bug is in the MACD chart YAxis (`src/components/TradingPlatform.tsx` ~line 1230):
```
domain={([min, max]) => { const m = ...; const z = m * 0.6; return [-z, z]; }}
allowDataOverflow
```
This shrinks the domain to 60% of the data range with `allowDataOverflow`, so MACD/Signal lines literally render outside the plot — exactly what the ALAB screenshot shows.

Fix:
- Replace the domain function with padded auto-fit: `const m = Math.max(Math.abs(min), Math.abs(max)) || 0.1; const z = m * 1.15; return [-z, z];`
- Remove `allowDataOverflow` so nothing draws past the axis.
- Result: every stock's MACD chart auto-scales to its own value range (small-cap pennies and large-caps both fit), and lines stay inside the panel.

### 3. BUY/SELL/HOLD next to each symbol must update every 30s from MACD
Current code already calls `fetchIntradayBatch` on `refetchInterval: 30_000`, but the badge falls back to a daily-data signal when the batch entry is missing or has < 30 bars, which makes it look stuck. Tighten:
- Keep the 30s refetch, but also set `refetchIntervalInBackground: true` so it keeps ticking when the tab is not focused.
- Change `queryKey: ["intradayBatch", watchlist]` to `["intradayBatch", [...watchlist].sort().join(",")]` so the key is value-stable (avoids accidental cache splits / stale entries when the array identity changes).
- In the badge render, use the live MACD signal whenever batch data exists (even if older than 30 bars use what we have via `getCurrentMacdSignal`); only fall back to the daily-data signal when batch is completely empty. This guarantees the badge reflects the latest blue-vs-red crossover from the 30s polled intraday data.
- Add a small "·30s" tooltip on the badge so the user can see it's the live MACD-driven value.

No backend schema changes, no new env vars, no UI redesign — three surgical edits to two files.

## Files touched
- `src/lib/quotes.functions.ts` — add `dayHigh`/`dayLow` to `LiveQuote` and populate in v7 + v8 paths.
- `src/components/TradingPlatform.tsx` — render Day H/L row, fix MACD YAxis domain, harden watchlist MACD signal refresh.
