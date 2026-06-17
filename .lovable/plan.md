## Goal
Stop the chart squish + null bid/ask issues. One readable OV chart per stock, real candles, touch panning, accurate prices.

## Scope of changes

### 1. Remove what's broken
- Delete the **BRYANTRADE MASTER · DAY TRADE SIGNAL CHART** card (the section starting around `TradingPlatform.tsx:2001`). That's the "trend bear" card with the squished candles.
- Delete the top-of-page `<a href="/charts">OV CHART</a>` button and the per-stock `OV CHART →` link.
- Delete `src/routes/charts.tsx` and the symbol-picker page entirely. OV becomes inline only.
- Remove all `<Brush>` components from the Price / OBV / MACD charts.

### 2. Inline OV chart (one per selected stock)
Add a single new card inside the stock detail view (replacing the deleted Master card) titled `OV · {SYMBOL} · 1D / 1m candles`:
- Fixed dataset: today's regular-session 1-minute bars from Yahoo (`range=1d&interval=1m`), pulled per selected stock.
- **Thick candlesticks** rendered via a custom Recharts `shape` (real OHLC body + wick, min body height 2px, body width ≈ 70% of slot).
- Overlays: cream 20MA line, dark-red 200MA line, yellow volume bars in a 60px sub-panel below.
- Signals: green `BULL` label 8px under candle low, red `SELL` label 8px over candle high (Elephant Bar + Tail Bar logic already in `VelezOpenIndicators.tsx` — reuse `getElephantBarMarkers`).
- Y-axis: dynamic domain `[min(low)*0.998, max(high)*1.002]` with 2-decimal `$` ticks.
- X-axis: HH:MM ticks, `minTickGap=60`.
- Legend row + disclaimer text as user specified.

### 3. Touch panning instead of sliders
Wrap each chart's `<ResponsiveContainer>` in a horizontally scrollable div:
```tsx
<div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch", touchAction: "pan-x" }}>
  <div style={{ width: Math.max(containerWidth, bars.length * 6) }}>
    <ResponsiveContainer ...>
```
This gives finger-drag pan across the full day; no Brush component anywhere.

### 4. OBV chart → minute-by-minute + pannable
- Switch OBV data source from current `intradayInterval` to fixed 1-minute bars (same Yahoo fetch as OV).
- Apply the same scrollable-wrapper pattern from step 3. Remove its `<Brush>`.

### 5. Bid/Ask accuracy (Yahoo Finance, sub-second)
In `src/lib/quotes.functions.ts`:
- Replace current single-call logic with a **fallback chain** per symbol:
  1. Yahoo `v7/finance/quote` (returns `bid`, `ask`, `bidSize`, `askSize`, `regularMarketPrice`)
  2. If `bid==null || ask==null || bid==0 || ask==0`: fall back to `v8/finance/chart?range=1d&interval=1m` last bar's close ± half typical spread
  3. If still missing: synthesize bid = mark − 0.01, ask = mark + 0.01 and flag `synthetic: true`
- Cache for 800ms (sub-second refresh).
- Add server-side log line `[quotes] sym=NVDA src=v7 bid=… ask=… age=…ms` so we can verify in logs.
- Remove the "3%/25% sanity check" that was silently nuking valid wide spreads.
- Remove the 🐛 debug toggle UI in `TradingPlatform.tsx`.

### 6. Keep working
- 1D/2D/5D/14D/30D/60D/90D/120D and 1m/5m/15m selectors for the **main Price / Bollinger** chart stay exactly as they are (no Brush, but otherwise unchanged).
- MACD chart stays (no Brush, dynamic Y-domain), but no longer has the duplicate candle panel — just histogram + signal lines.

## Technical details
- Custom candle: `const Candle = ({ x, y, width, height, payload }) => { const { o,h,l,c } = payload; const color = c>=o ? '#26a641' : '#f85149'; ... }` passed as `shape={<Candle />}` on a `<Bar dataKey="hlRange" />` with custom `y` mapping.
- Touch panning width formula: `barCount * pxPerBar` where `pxPerBar = 6` for 1m bars (giving ~2340px for a 390-bar regular session, ~6× viewport scroll).
- Yahoo v7 endpoint: `https://query1.finance.yahoo.com/v7/finance/quote?symbols=...&fields=bid,ask,bidSize,askSize,regularMarketPrice,marketState` (already used elsewhere in the file).

## Files touched
- `src/components/TradingPlatform.tsx` — delete Master card, delete OV button, delete all Brushes, add inline OV card, wrap charts in scroll container, switch OBV to 1m, remove bid/ask debug row.
- `src/lib/quotes.functions.ts` — rewrite bid/ask fetch with fallback chain + 800ms cache + logging.
- `src/routes/charts.tsx` — delete.
- `src/components/VelezOpenIndicators.tsx` — keep `getElephantBarMarkers` + helpers, but the `VelezChartPanel` component is no longer imported anywhere (leave file for the helpers).

## Out of scope (ask if you want these too)
- After-hours / pre-market overlay on the OV chart.
- Real-time streaming (currently polled).
- Replacing Recharts with a true financial-charting library (TradingView lightweight-charts) — bigger lift; tell me if you want that swap instead of the custom shape.
