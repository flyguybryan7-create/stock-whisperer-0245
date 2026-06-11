# Plan: Watchlist Grid + Detail Overlay Redesign

Restructure `TradingPlatform.tsx` into a mobile-first full-screen watchlist with a fixed detail overlay, plus a faster bid/ask feed.

## 1. Layout shell (TradingPlatform.tsx)

- Wrap the whole component in a root `div` with `paddingTop: "env(safe-area-inset-top, 0px)"` and background `#010409`.
- Make the existing BRYANTRADE header `div` `position: "sticky", top: 0, zIndex: 100` so it stays pinned (and visible below the iPhone notch).
- Remove the existing two-column grid (watchlist left / detail right). Watchlist becomes the full-screen base view.

## 2. Detail overlay

- New state: `const [showDetail, setShowDetail] = useState(false)`.
- Extract the current right-panel detail JSX (chart, quote header, bid/ask, options, etc.) into a fixed overlay:
  - `position: "fixed", inset: 0, zIndex: 200, background: "#010409", overflowY: "auto"`.
  - Rendered only when `showDetail`.
  - Top bar: `← WATCHLIST` button (transparent, `#58a6ff`, 13px/700, padding `12px 16px`) that calls `setShowDetail(false)`.
- In `onWatchlistRowClick`, after `setSelectedStock(sym)` call `setShowDetail(true)` (reorder-mode branch unchanged — no overlay open).

## 3. 3×4 tile grid

- Replace vertical watchlist list with:
  - Container: `overflowY: "auto", maxHeight: "calc(100vh - env(safe-area-inset-top, 0px) - 49px)"`.
  - Grid: `display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: 6, padding: "8px"`.
- Each tile: `height: 90, position: "relative", padding: "8px 10px", borderRadius: 6, overflow: "hidden"`.
- Below the grid: `▼ more` label, `#8b949e`, `fontSize: 9`, `textAlign: "center"`.

## 4. Tile content (4 rows)

- **Row 1**: tiny `✕` remove button (fontSize 10, `#6e7681`) + ticker bold 15px white on left; existing reorder `⋮⋮`/`✕` button + `⊕` drop indicator on right. Keep all reorder logic (`reorderModeSym`, `toggleReorderMode`, `onWatchlistRowClick`) untouched.
- **Row 2**: `stockNames[sym]` truncated (`ellipsis/nowrap/overflow:hidden`), 10px `#8b949e`, marginTop 2.
- **Row 3**: live price bold 13px `#e6edf3` + `+$X.XX`/`-$X.XX` + `(+X.XX%)` in `#39d353`/`#f85149`, all 11px on one line, marginTop 3.
- **Row 4**: `$` button (existing inline position editor unchanged). If `pos` exists: `{shares}sh @ ${entry}` in `#8b949e` 9px + P&L `(price-entry)*shares` as `+$X.XX (+X.XX%)` colored green/red. If no position: just the muted `$` button.
- Remove drag handle from inside tile body (reorder ⋮⋮ on Row 1 right stays).
- Remove the `{sig}` BUY/SELL/HOLD text span — signal is communicated by background flash.
- Options flow badge (`C↑`/`P↓`/`UNU`) moved to Row 4 at 9px alongside/replacing the old VWAP slot.

## 5. MACD-driven flashing

- Tile `animation` prop:
  - BUY → `"flashBuy 1.4s ease-in-out infinite"`
  - SELL → `"flashSell 1.4s ease-in-out infinite"`
  - HOLD → `"flashHold 2s ease-in-out infinite"`
- Add to the existing `<style>` block:
  - `@keyframes flashHold { 0%,100% { background: rgba(227,179,65,0.12); } 50% { background: rgba(227,179,65,0.03); } }`
  - Confirm/keep existing `flashBuy`/`flashSell` keyframes (add if missing using same pattern with `#39d353` / `#f85149` rgba).
- Reorder highlight: when `reorderModeSym === sym`, override border to `2px solid #d2a8ff`.

## 6. Viewport meta + body styles

- Update `index.html` `<meta name="viewport">` to `width=device-width, initial-scale=1, viewport-fit=cover`.
- In the component's `<style>` block add `body { padding-top: env(safe-area-inset-top, 0px); background: #010409; }`.

## 7. Fastest bid/ask (quotes.functions.ts + TradingPlatform)

- Rewrite `getBidAsk` to call `https://query2.finance.yahoo.com/v8/finance/quote?symbols=${symbol}&fields=bid,ask,bidSize,askSize,regularMarketPrice,regularMarketPreviousClose`.
- Parse `quoteResponse.result[0]` → return `{ bid, ask, bidSize, askSize }` (null on miss).
- In `TradingPlatform`, change the `bidask` `useQuery` to `refetchInterval: 250`, `staleTime: 0`, keep `refetchIntervalInBackground: true`.

## Files touched

- `src/components/TradingPlatform.tsx` — major edit (layout, overlay, grid, tile, flash, styles).
- `src/lib/quotes.functions.ts` — rewrite `getBidAsk`.
- `index.html` — viewport meta tag.

## Out of scope

No backend/auth/schema changes. No edits to other routes or components.
