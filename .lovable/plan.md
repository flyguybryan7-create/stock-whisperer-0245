# Plan

## 1. Fix "Connect Schwab" — verify it actually persists
Symptom: OAuth returns to the callback but the badge doesn't show connected.

- Log `[schwab] persistOwner` result + exchange result in `auth.schwab.callback.tsx`.
- On success, also write to `localStorage` a flag `bryantrade.schwab.connected = 1` and read it in `TradingPlatform` for the badge state (not just presence of tokens in sessionStorage, which is cleared on tab close — that's likely why "X out and go back" loses the connection).
- Move token storage to `localStorage` (keep sessionStorage as fallback) so closing the Schwab tab and returning to BryanTrade retains the session.
- Add a visible toast + status line on the callback page explaining success/failure.
- Add a "🟢 Schwab Live" vs "⚪ Schwab Off" pill next to the Connect button driven by an actual live `getSchwabQuotes` ping every 30s.

## 2. What your Schwab API keys unlock (advisory — no code)
With individual developer keys you get:
- Real-time NBBO quotes (bid/ask/last/size)
- Full option chains + Greeks + volume/OI (used for CALL/PUT TGT and P/C ratio)
- Price history incl. **extended hours** (pre 4am, post 8pm — but Schwab only publishes ETH bars 4am–8pm ET; 8pm–4am is truly dark for most equities. 24hr bars only exist for the ~50 symbols on the NYSE/Nasdaq overnight session, which Schwab does surface via the same `pricehistory` endpoint. Nothing unlocks TOS-style 24h for symbols that don't trade overnight — the tape doesn't exist.)
- Fundamentals (short float, shares out, avg volume)
- Movers by index
- **NOT included** without additional entitlement: level 2, streaming websocket (requires separate Schwab streamer entitlement + account-linked app approval), futures data.

Action: I'll wire the overnight-eligible symbol list (`AAPL`, `TSLA`, `NVDA`, `AMZN`, `MSFT`, `META`, `GOOG`, `SPY`, `QQQ` + ~40 others Schwab supports) into the 24H chart mode so those specific tickers get real 8pm–4am bars.

## 3. Put/Call Ratio badge
- Extend `getSchwabTopStrikes` to also return `putVolume/callVolume` (already collected) and expose a **P/C Ratio** in the header for the active symbol: `<0.7 bullish, 0.7–1.0 neutral, >1.0 bearish`, color-coded.

## 4. Real Asia-linked SEMI RISK
Rebuild `fetchSemiRiskSentimentSnapshot` in `market-pulse.server.ts` to weight:
- KOSPI (^KS11) 15%
- STAR 50 (000688.SS) 15%
- PHLX Semi (^SOX) 25%
- TAIEX (^TWII) 15%
- Nikkei 225 (^N225) 15%
- Hang Seng Tech (^HSTECH) 15%

Compute weighted daily % change → map to a 0-100 risk score → display as "SEMI RISK 62% ↑" with implied ES/NQ drag: `impliedNQ = -weightedPct * 0.6`.

## 5. Fix CALL/PUT TGT percentages (should reflect real flow)
Current pct = `topStrikeVolume / totalExpiryVolume` (per side). That never sums to 100% across strikes because we only show the top. Change to:
- Show **top 2 call strikes + top 2 put strikes** with `strike · pct-of-side-volume`.
- Add "Σ Calls / Σ Puts" line so the user sees flow distribution.
- Percentages on each row are share of that side's total volume; the two shown per side won't sum to 100 (rest is spread across other strikes) — label as "flow share".

## 6. 'E' econ-event markers
- New `src/lib/econ-calendar.functions.ts` pulling from a free source:
  - Primary: Trading Economics calendar RSS (public) or FRED ALFRED release calendar
  - Fallback: Federal Reserve calendar JSON
- Filter to high-impact US releases: CPI, PCE, NFP, FOMC, GDP, PPI, Retail Sales, Unemployment, ISM, Fed speakers.
- Show yellow **E** markers on Master chart at release timestamp, same rendering pattern as the blue **N** news markers.

## 7. Replace MACD chart with day-trader chart
Options (I'll pick **A** unless you say otherwise):
- **A. VWAP + Anchored VWAP bands + Cumulative Delta proxy** — shows session VWAP, ±1σ / ±2σ bands, plus a rolling "aggressor volume" bar (up-vol − down-vol) which day traders use for exhaustion/absorption reads. Pans/zooms identically to the Master chart.
- B. Level 2 tape simulation (not possible without L2 entitlement).
- C. Relative Volume (RVOL) histogram vs 20-day avg per bar.

## Files touched
- `src/routes/auth.schwab.callback.tsx` — persistence fix
- `src/components/TradingPlatform.tsx` — badge, P/C ratio, flow rows, E markers, new chart, remove MACD
- `src/lib/schwab.functions.ts` — expose P/C, top-2 strikes
- `src/lib/schwab-shared.functions.ts` — same
- `src/lib/market-pulse.server.ts` — Asia-weighted SEMI RISK
- `src/lib/econ-calendar.functions.ts` — new
