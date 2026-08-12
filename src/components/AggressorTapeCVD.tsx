import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid, ReferenceLine,
  ResponsiveContainer, Tooltip,
} from "recharts";
import { getSchwabQuotes, refreshSchwabToken, type SchwabTokens } from "@/lib/schwab.functions";
import { getSharedSchwabQuotes } from "@/lib/schwab-shared.functions";

const mono = "SF Mono, Menlo, monospace";

type Print = {
  t: number;         // unix ms
  price: number;
  size: number;      // shares traded since last poll (delta of totalVolume)
  side: "BUY" | "SELL" | "MID";
  cvd: number;       // running cumulative volume delta after this print
};

type Props = {
  symbol: string;
  tokens: SchwabTokens | null;
  onTokens: (t: SchwabTokens) => void;
  // When true, we can pull quotes via the shared server-side owner token
  // instead of this tab's localStorage. Lets the tape run even when the
  // OAuth callback landed on a different origin (preview vs published).
  sharedAvailable?: boolean;
  // Called when a stored Schwab token is dead (revoked or expired). The parent
  // clears local/shared connection state so the UI asks for a fresh reconnect.
  onTokensInvalid?: () => void;
};

function fmtVol(v: number): string {
  const a = Math.abs(v);
  if (a >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (a >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${v}`;
}

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}

// Lee–Ready tick rule: classify a print as buyer- or seller-initiated using
// the last-trade price relative to the NBBO, with an uptick/downtick fallback
// when the trade lands mid-spread. This is what desks use to build CVD when
// full Level 2 book depth isn't available (Schwab REST doesn't expose L2).
function classify(last: number, bid: number | null, ask: number | null, prevLast: number | null): "BUY" | "SELL" | "MID" {
  if (ask != null && last >= ask) return "BUY";
  if (bid != null && last <= bid) return "SELL";
  if (prevLast != null) {
    if (last > prevLast) return "BUY";
    if (last < prevLast) return "SELL";
  }
  return "MID";
}

// Schwab returns invalid_grant / unsupported_token_type once a refresh token
// has been revoked or aged out. Retrying that never succeeds — the stored
// token has to be dropped.
function isDeadRefresh(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("invalid_grant") || m.includes("unsupported_token_type") || m.includes("expired or revoked");
}

// ---------------------------------------------------------------------------
// Signal engine
//
// Everything below is derived from the same NBBO tape the CVD is built from,
// so the recommendation moves in lockstep with what's drawn on the chart.
// Four confirming inputs, scored -1..+1 each:
//   1. CVD slope       — is net aggressor flow accelerating up or down?
//   2. Flow imbalance  — what share of recent volume lifted the offer?
//   3. Price momentum  — is price confirming the flow?
//   4. Divergence      — flow pushing one way while price refuses to follow
//                        (absorption) is the highest-conviction reversal tell.
// A weighted score crosses +/- thresholds to fire a B or S marker; we throttle
// so the tape doesn't spray a marker on every single poll.
// ---------------------------------------------------------------------------
type Signal = { t: number; price: number; action: "B" | "S"; score: number; reason: string };

const SIGNAL_LOOKBACK = 24;      // prints used for slope / imbalance
// A "true" signal is rare on purpose: high conviction, sustained for two
// consecutive polls, and spaced far enough apart that the tape shows a
// handful of calls per session instead of a blob of letters.
const SIGNAL_MIN_GAP_MS = 300_000;      // same-direction repeat
const SIGNAL_FLIP_GAP_MS = 150_000;     // direction change
const SIGNAL_THRESHOLD = 0.82;
const MAX_VISIBLE_SIGNALS = 2;
// Consecutive polls that must agree before a mark is stamped.
const SIGNAL_CONFIRM_POLLS = 3;
// Minimum on-screen separation between two stamped marks so letters never
// overlap each other on the price line.
const MARKER_SPACING_MS = 90_000;
// Empty gutter kept on the right of the time axis so the newest prints and
// B/S marks never render flush against the panel edge.
const RIGHT_GUTTER_MS = 45_000;

function linSlope(vals: number[]): number {
  const n = vals.length;
  if (n < 2) return 0;
  let sx = 0, sy = 0, sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sx += i; sy += vals[i]!; sxy += i * vals[i]!; sxx += i * i; }
  const denom = n * sxx - sx * sx;
  if (denom === 0) return 0;
  return (n * sxy - sx * sy) / denom;
}

function clamp(v: number): number { return Math.max(-1, Math.min(1, v)); }

function scoreWindow(win: Print[]): { score: number; reason: string } | null {
  if (win.length < 6) return null;
  const cvds = win.map((p) => p.cvd);
  const prices = win.map((p) => p.price);

  let buy = 0, sell = 0;
  for (const p of win) {
    if (p.side === "BUY") buy += p.size;
    else if (p.side === "SELL") sell += p.size;
  }
  const totalVol = buy + sell;
  if (totalVol <= 0) return null;

  // Normalize the CVD slope by average print size so it's ticker-agnostic.
  const avgSize = totalVol / win.length;
  const cvdSlope = clamp(linSlope(cvds) / (avgSize || 1));
  const imbalance = clamp((buy - sell) / totalVol);

  const first = prices[0]!;
  const last = prices[prices.length - 1]!;
  const priceMove = first > 0 ? (last - first) / first : 0;
  // 0.15% over the window is a full-strength move for an intraday tape.
  const momentum = clamp(priceMove / 0.0015);

  // Divergence: strong flow one way, price flat or against it => absorption.
  const flow = (cvdSlope + imbalance) / 2;
  const divergence = Math.abs(flow) > 0.4 && Math.sign(momentum || 0) !== Math.sign(flow)
    ? -clamp(flow) // fade the aggressors being absorbed
    : 0;

  const score = clamp(0.35 * cvdSlope + 0.3 * imbalance + 0.2 * momentum + 0.15 * divergence * 2);

  let reason: string;
  if (divergence !== 0) reason = flow > 0 ? "buy flow absorbed at highs" : "sell flow absorbed at lows";
  else if (Math.abs(imbalance) > 0.5) reason = imbalance > 0 ? "offers lifted, CVD rising" : "bids hit, CVD falling";
  else reason = score > 0 ? "flow + price confirming up" : "flow + price confirming down";

  return { score, reason };
}

export function AggressorTapeCVD({ symbol, tokens, onTokens, sharedAvailable = false, onTokensInvalid }: Props) {
  const fetchQuotes = useServerFn(getSchwabQuotes);
  const refresh = useServerFn(refreshSchwabToken);
  const fetchSharedQuotes = useServerFn(getSharedSchwabQuotes);
  const [prints, setPrints] = useState<Print[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const lastVolRef = useRef<number | null>(null);
  const lastPriceRef = useRef<number | null>(null);
  const cvdRef = useRef<number>(0);
  const symbolRef = useRef(symbol);
  // Shared-feed failures are usually transient (rate limit, 5xx, brief blip).
  // Only treat the connection as dead after several consecutive misses.
  const sharedFailRef = useRef(0);
  const [signals, setSignals] = useState<Signal[]>([]);
  const lastSignalRef = useRef<{ t: number; action: "B" | "S" } | null>(null);
  // Previous poll's candidate action — a signal only fires when the same
  // read repeats, which filters out one-tick flickers.
  const pendingRef = useRef<{ action: "B" | "S"; count: number } | null>(null);

  // Reset the tape when the user switches tickers so buy/sell/CVD reflect
  // only the currently displayed symbol.
  useEffect(() => {
    if (symbolRef.current !== symbol) {
      symbolRef.current = symbol;
      setPrints([]);
      setSignals([]);
      lastSignalRef.current = null;
      pendingRef.current = null;
      cvdRef.current = 0;
      lastVolRef.current = null;
      lastPriceRef.current = null;
    }
  }, [symbol]);

  useEffect(() => {
    if (!symbol) return;
    // If this tab has no personal token but the shared server-side owner
    // token is available, poll the shared endpoint instead.
    const useShared = !tokens?.access_token;
    if (useShared && !sharedAvailable) return;
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        let quotes: Record<string, { last: number | null; bid: number | null; ask: number | null; totalVolume: number | null }> | null;
        if (useShared) {
          quotes = await fetchSharedQuotes({ data: { symbols: [symbol] } });
          if (!quotes) {
            sharedFailRef.current += 1;
            if (sharedFailRef.current >= 5) {
              setStatus("reconnect Schwab");
              onTokensInvalid?.();
            } else {
              setStatus("shared feed hiccup — retrying…");
            }
            return;
          }
          sharedFailRef.current = 0;
        } else {
          let token = tokens!.access_token;
          try {
            quotes = await fetchQuotes({ data: { accessToken: token, symbols: [symbol] } });
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            if (msg.includes("schwab_unauthorized") && tokens!.refresh_token) {
              let fresh: SchwabTokens;
              try {
                fresh = await refresh({ data: { refreshToken: tokens!.refresh_token } });
              } catch (re) {
                const rmsg = re instanceof Error ? re.message : String(re);
                if (isDeadRefresh(rmsg)) {
                  // Drop the dead token; the effect re-runs and either uses the
                  // shared server token or shows the connect prompt.
                  setStatus(sharedAvailable ? "switching to shared feed…" : "reconnect Schwab");
                  onTokensInvalid?.();
                  return;
                }
                throw re;
              }
              onTokens(fresh);
              token = fresh.access_token;
              quotes = await fetchQuotes({ data: { accessToken: token, symbols: [symbol] } });
            } else {
              throw e;
            }
          }
        }
        const q = quotes?.[symbol];
        if (!q || q.last == null || q.totalVolume == null) {
          setStatus("waiting for quote…");
          return;
        }
        const prevVol = lastVolRef.current;
        const prevPrice = lastPriceRef.current;
        lastVolRef.current = q.totalVolume;
        lastPriceRef.current = q.last;
        // First tick — seed baseline, don't record a print (we can't know the
        // size of pre-existing session volume).
        if (prevVol == null) {
          setStatus("live");
          return;
        }
        const delta = q.totalVolume - prevVol;
        if (delta <= 0) {
          setStatus("live");
          return;
        }
        const side = classify(q.last, q.bid, q.ask, prevPrice);
        const signed = side === "BUY" ? delta : side === "SELL" ? -delta : 0;
        cvdRef.current += signed;
        const print: Print = {
          t: Date.now(),
          price: q.last,
          size: delta,
          side,
          cvd: cvdRef.current,
        };
        setPrints((prev) => {
          const next = [...prev, print];
          // Cap history so state stays cheap — 300 prints ≈ 10 min at 2s cadence.
          return next.length > 300 ? next.slice(next.length - 300) : next;
        });
        setStatus("live");
      } catch (e) {
        setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    tick();
    const id = setInterval(tick, 2000);
    return () => { cancelled = true; clearInterval(id); };
  }, [tokens, symbol, sharedAvailable, fetchQuotes, fetchSharedQuotes, refresh, onTokens, onTokensInvalid]);

  // Rolling window: only show the last WINDOW_MS of tape so the chart
  // "flows" with the market as new prints arrive instead of piling up
  // into a dense cluster. Older prints still contribute to totals/CVD
  // via the running refs, but the visualization stays readable.
  const WINDOW_MS = 4 * 60_000; // 4 minutes
  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), 2000);
    return () => clearInterval(id);
  }, []);
  const visiblePrints = useMemo(() => {
    const cutoff = nowTick - WINDOW_MS;
    return prints.filter((p) => p.t >= cutoff);
  }, [prints, nowTick]);

  // Volume threshold: hide dust prints so only meaningful aggressor
  // trades are dotted on the price line. Threshold scales with the
  // largest recent print so it adapts per-ticker.
  // Only the heaviest prints get dotted — everything else is noise on a
  // 2s poll and just fills the pane with overlapping circles.
  const dotThreshold = useMemo(() => {
    if (visiblePrints.length === 0) return 0;
    const sizes = visiblePrints.map((p) => p.size).sort((a, b) => b - a);
    // Keep roughly the top 20% of prints, and never fewer than the top 12.
    const cutIdx = Math.min(sizes.length - 1, Math.max(11, Math.floor(sizes.length * 0.2)));
    return Math.max(sizes[cutIdx] ?? 0, 100);
  }, [visiblePrints]);

  const chartData = useMemo(() => visiblePrints.map((p) => ({
    t: p.t,
    price: p.price,
    cvd: p.cvd,
    buySize: p.side === "BUY" && p.size >= dotThreshold ? p.size : null,
    sellSize: p.side === "SELL" && p.size >= dotThreshold ? p.size : null,
  })), [visiblePrints, dotThreshold]);

  // Summary strip reflects the same rolling window as the chart so the
  // BUY / SELL / NET numbers describe what the trader is looking at.
  const totals = useMemo(() => {
    let buy = 0, sell = 0, mid = 0;
    let cvd = 0;
    for (const p of visiblePrints) {
      if (p.side === "BUY") buy += p.size;
      else if (p.side === "SELL") sell += p.size;
      else mid += p.size;
      cvd += p.side === "BUY" ? p.size : p.side === "SELL" ? -p.size : 0;
    }
    return { buy, sell, mid, cvd, delta: buy - sell };
  }, [visiblePrints]);

  const imbalancePct = totals.buy + totals.sell > 0
    ? (totals.buy - totals.sell) / (totals.buy + totals.sell)
    : 0;

  // Live recommendation: recomputed on every new print from the trailing window.
  const live = useMemo(() => {
    const win = prints.slice(-SIGNAL_LOOKBACK);
    const s = scoreWindow(win);
    if (!s) return null;
    const action: "B" | "S" | "WAIT" =
      s.score >= SIGNAL_THRESHOLD ? "B" : s.score <= -SIGNAL_THRESHOLD ? "S" : "WAIT";
    return { ...s, action, price: win[win.length - 1]?.price ?? null };
  }, [prints]);

  // Commit a marker onto the tape when conviction crosses the threshold,
  // throttled so we don't stamp the same call every 2s.
  useEffect(() => {
    if (!live || live.action === "WAIT" || live.price == null) {
      pendingRef.current = null;
      return;
    }
    const action = live.action as "B" | "S";
    // Require several consecutive polls agreeing before stamping the tape.
    if (pendingRef.current?.action !== action) {
      pendingRef.current = { action, count: 1 };
      return;
    }
    pendingRef.current.count += 1;
    if (pendingRef.current.count < SIGNAL_CONFIRM_POLLS) return;
    const now = Date.now();
    const prev = lastSignalRef.current;
    if (prev) {
      const gap = prev.action === action ? SIGNAL_MIN_GAP_MS : SIGNAL_FLIP_GAP_MS;
      if (now - prev.t < gap) return;
    }
    lastSignalRef.current = { t: now, action };
    setSignals((s) => {
      const next = [...s, { t: now, price: live.price!, action, score: live.score, reason: live.reason }];
      return next.length > 20 ? next.slice(next.length - 20) : next;
    });
  }, [live]);

  const visibleSignals = useMemo(() => {
    const inWindow = signals.filter((s) => s.t >= nowTick - WINDOW_MS);
    // Walk newest → oldest and drop any mark that would render on top of a
    // more recent one, then keep only the last few.
    const spaced: typeof inWindow = [];
    for (let i = inWindow.length - 1; i >= 0; i--) {
      const s = inWindow[i]!;
      const last = spaced[spaced.length - 1];
      if (!last || last.t - s.t >= MARKER_SPACING_MS) spaced.push(s);
    }
    spaced.reverse();
    return spaced.slice(-MAX_VISIBLE_SIGNALS);
  }, [signals, nowTick]);
  const buyMarks = useMemo(() => visibleSignals.filter((s) => s.action === "B"), [visibleSignals]);
  const sellMarks = useMemo(() => visibleSignals.filter((s) => s.action === "S"), [visibleSignals]);

  const priceDomain = useMemo<[number, number] | ["auto", "auto"]>(() => {
    if (chartData.length === 0) return ["auto", "auto"];
    let min = Infinity, max = -Infinity;
    for (const d of chartData) { if (d.price < min) min = d.price; if (d.price > max) max = d.price; }
    if (!Number.isFinite(min) || !Number.isFinite(max)) return ["auto", "auto"];
    const pad = Math.max((max - min) * 0.1, 0.05);
    return [min - pad, max + pad];
  }, [chartData]);

  const cvdDomain = useMemo<[number, number] | ["auto", "auto"]>(() => {
    if (chartData.length === 0) return ["auto", "auto"];
    let min = 0, max = 0;
    for (const d of chartData) { if (d.cvd < min) min = d.cvd; if (d.cvd > max) max = d.cvd; }
    const span = Math.max(Math.abs(min), Math.abs(max), 100);
    return [-span * 1.1, span * 1.1];
  }, [chartData]);

  if (!tokens?.access_token && !sharedAvailable) {
    return (
      <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
        <div style={{ fontSize: 10, color: "#d2a8ff", letterSpacing: 1.5, fontWeight: 700, marginBottom: 6 }}>
          🎯 AGGRESSOR TAPE + CVD · {symbol}
        </div>
        <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.5 }}>
          Connect Schwab to stream real-time bid/ask/last and build the Cumulative Volume Delta tape.
          This chart classifies each print as buy- or sell-initiated via the Lee–Ready rule and tracks
          where net flow is pushing price.
        </div>
      </div>
    );
  }

  return (
    <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 10, marginBottom: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#d2a8ff", letterSpacing: 1.5, fontWeight: 700 }}>
          🎯 AGGRESSOR TAPE + CVD · {symbol}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: mono, fontSize: 10 }}>
          <span style={{ padding: "2px 6px", background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: status === "live" ? "#39d353" : "#e3b341" }}>
            {status === "live" ? "● LIVE 2s" : status.toUpperCase()}
          </span>
        </div>
      </div>

      {/* Summary strip: buy vol, sell vol, net delta, imbalance % */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
        <div style={{ padding: 6, background: "rgba(57,211,83,0.08)", border: "1px solid #39d353", borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>BUY VOL</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#39d353", fontFamily: mono }}>{fmtVol(totals.buy)}</div>
        </div>
        <div style={{ padding: 6, background: "rgba(248,81,73,0.08)", border: "1px solid #f85149", borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>SELL VOL</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#f85149", fontFamily: mono }}>{fmtVol(totals.sell)}</div>
        </div>
        <div style={{ padding: 6, background: "#010409", border: `1px solid ${totals.delta >= 0 ? "#39d353" : "#f85149"}`, borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>NET Δ</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: totals.delta >= 0 ? "#39d353" : "#f85149", fontFamily: mono }}>
            {totals.delta >= 0 ? "+" : ""}{fmtVol(totals.delta)}
          </div>
        </div>
        <div style={{ padding: 6, background: "#010409", border: "1px solid #30363d", borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>IMBALANCE</div>
          <div style={{ fontSize: 13, fontWeight: 800, color: imbalancePct >= 0 ? "#39d353" : "#f85149", fontFamily: mono }}>
            {imbalancePct >= 0 ? "+" : ""}{(imbalancePct * 100).toFixed(1)}%
          </div>
        </div>
      </div>

      {/* Live recommendation derived from the same tape the chart draws */}
      <div style={{
        display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 8px",
        background: "#010409", borderRadius: 4,
        border: `1px solid ${live?.action === "B" ? "#39d353" : live?.action === "S" ? "#f85149" : "#30363d"}`,
      }}>
        <div style={{
          width: 26, height: 26, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: mono, fontSize: 14, fontWeight: 900,
          background: live?.action === "B" ? "#39d353" : live?.action === "S" ? "#f85149" : "#21262d",
          color: live?.action === "B" || live?.action === "S" ? "#010409" : "#8b949e",
        }}>
          {live?.action === "B" ? "B" : live?.action === "S" ? "S" : "–"}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>LIVE READ</div>
          <div style={{ fontSize: 10, color: "#c9d1d9", fontFamily: mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {live ? `${live.action === "WAIT" ? "NO EDGE" : live.action === "B" ? "BUY" : "SELL"} · ${live.reason}` : "building tape…"}
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>CONVICTION</div>
          <div style={{ fontSize: 12, fontWeight: 800, fontFamily: mono, color: live && live.score >= 0 ? "#39d353" : "#f85149" }}>
            {live ? `${Math.round(Math.abs(live.score) * 100)}%` : "—"}
          </div>
        </div>
      </div>

      {chartData.length < 2 ? (
        <div style={{ padding: 20, textAlign: "center", fontSize: 10, color: "#6e7681" }}>
          Waiting for trades… (needs at least 2 quote polls to compute the first print)
        </div>
      ) : (
        <>
          {/* Top pane: price line + colored buy/sell prints sized by trade volume */}
          <div style={{ fontSize: 9, color: "#8b949e", fontFamily: mono, padding: "0 4px 2px" }}>PRICE · aggressor prints</div>
          <ResponsiveContainer width="100%" height={210}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 44, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="t" type="number" scale="time"
                domain={[nowTick - WINDOW_MS, nowTick + RIGHT_GUTTER_MS]} tickFormatter={fmtTime}
                stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} allowDataOverflow />
              <YAxis yAxisId="p" domain={priceDomain} stroke="#8b949e" fontSize={9} width={54}
                tick={{ fontFamily: mono }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11, fontFamily: mono }}
                labelFormatter={(v: number) => fmtTime(v)}
                formatter={(val: unknown, name: string) => {
                  if (val == null) return ["—", name];
                  if (name === "price") return [`$${Number(val).toFixed(2)}`, "price"];
                  if (name === "buySize") return [`${fmtVol(Number(val))} @ ask`, "BUY"];
                  if (name === "sellSize") return [`${fmtVol(Number(val))} @ bid`, "SELL"];
                  return [String(val), name];
                }}
              />
              <Line yAxisId="p" type="monotone" dataKey="price" stroke="#58a6ff" strokeWidth={1.5}
                dot={false} isAnimationActive={false} />
              <Scatter yAxisId="p" dataKey="price" data={chartData.filter((d) => d.buySize)} fill="#39d353"
                isAnimationActive={false}
                shape={(props: { cx?: number; cy?: number; fill?: string }) => (
                  <circle cx={props.cx} cy={props.cy} r={2.5} fill={props.fill} fillOpacity={0.85} />
                )} />
              <Scatter yAxisId="p" dataKey="price" data={chartData.filter((d) => d.sellSize)} fill="#f85149"
                isAnimationActive={false}
                shape={(props: { cx?: number; cy?: number; fill?: string }) => (
                  <circle cx={props.cx} cy={props.cy} r={2.5} fill={props.fill} fillOpacity={0.85} />
                )} />
              {/* B / S recommendation markers stamped on the price line */}
              <Scatter yAxisId="p" dataKey="price" data={buyMarks} isAnimationActive={false}
                shape={(props: { cx?: number; cy?: number }) => (
                  <g>
                    <line x1={props.cx} y1={(props.cy ?? 0) + 4} x2={props.cx} y2={(props.cy ?? 0) + 20}
                      stroke="#39d353" strokeWidth={1} strokeOpacity={0.6} />
                    <circle cx={props.cx} cy={(props.cy ?? 0) + 28} r={9} fill="#39d353" fillOpacity={0.95}
                      stroke="#010409" strokeWidth={1.5} />
                    <text x={props.cx} y={(props.cy ?? 0) + 28} textAnchor="middle" dominantBaseline="central"
                      fontSize={11} fontWeight={900} fontFamily={mono} fill="#010409">B</text>
                  </g>
                )} />
              <Scatter yAxisId="p" dataKey="price" data={sellMarks} isAnimationActive={false}
                shape={(props: { cx?: number; cy?: number }) => (
                  <g>
                    <line x1={props.cx} y1={(props.cy ?? 0) - 4} x2={props.cx} y2={(props.cy ?? 0) - 20}
                      stroke="#f85149" strokeWidth={1} strokeOpacity={0.6} />
                    <circle cx={props.cx} cy={(props.cy ?? 0) - 28} r={9} fill="#f85149" fillOpacity={0.95}
                      stroke="#010409" strokeWidth={1.5} />
                    <text x={props.cx} y={(props.cy ?? 0) - 28} textAnchor="middle" dominantBaseline="central"
                      fontSize={11} fontWeight={900} fontFamily={mono} fill="#010409">S</text>
                  </g>
                )} />
            </ComposedChart>
          </ResponsiveContainer>

          {/* Bottom pane: Cumulative Volume Delta line — where flow is pushing */}
          <div style={{ fontSize: 9, color: "#8b949e", fontFamily: mono, padding: "4px 4px 2px" }}>CUMULATIVE VOLUME DELTA</div>
          <ResponsiveContainer width="100%" height={110}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 44, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="t" type="number" scale="time"
                domain={[nowTick - WINDOW_MS, nowTick + RIGHT_GUTTER_MS]} tickFormatter={fmtTime}
                stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} allowDataOverflow />
              <YAxis domain={cvdDomain} stroke="#8b949e" fontSize={9} width={54}
                tick={{ fontFamily: mono }} tickFormatter={(v: number) => fmtVol(v)} />
              <ReferenceLine y={0} stroke="#484f58" />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11, fontFamily: mono }}
                labelFormatter={(v: number) => fmtTime(v)}
                formatter={(val: unknown) => [`${Number(val) >= 0 ? "+" : ""}${fmtVol(Number(val))}`, "CVD"]}
              />
              <Line type="monotone" dataKey="cvd" stroke={totals.cvd >= 0 ? "#39d353" : "#f85149"}
                strokeWidth={1.75} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>

          <div style={{ fontSize: 9, color: "#6e7681", textAlign: "center", padding: "4px 0 0" }}>
            Lee–Ready tick rule · dots = heaviest prints only · B/S marks fire only on high-conviction reads (≥72%) confirmed on two polls · polls every 2s · not financial advice
          </div>
        </>
      )}
    </div>
  );
}