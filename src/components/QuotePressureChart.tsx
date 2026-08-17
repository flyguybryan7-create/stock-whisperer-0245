import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ComposedChart, Line, Bar, Cell, XAxis, YAxis, CartesianGrid, ReferenceLine,
  ResponsiveContainer, Tooltip,
} from "recharts";
import { getSchwabQuotes, refreshSchwabToken, type SchwabTokens } from "@/lib/schwab.functions";
import { getSharedSchwabQuotes } from "@/lib/schwab-shared.functions";

/**
 * Quote Pressure — bid/ask microstructure predictor on a 5s poll.
 *
 * With only NBBO snapshots (no L2 depth) the two statistics that actually
 * carry short-horizon predictive power are:
 *
 *   1. Order-book imbalance (OBI) = (bidSize - askSize) / (bidSize + askSize)
 *      More size resting on the bid than the offer => next tick skews up.
 *   2. Microprice skew — the size-weighted "true" price:
 *        micro = (bid * askSize + ask * bidSize) / (bidSize + askSize)
 *      Its distance from the mid, expressed in spreads, is the classic
 *      Stoikov microprice signal: price tends to drift toward the microprice.
 *
 * We blend a smoothed OBI, the microprice skew, and recent mid drift into a
 * single pressure score, print a direction call for the next ~15s, and then
 * grade it against what actually happened so the hit-rate is visible.
 */

const mono = "SF Mono, Menlo, monospace";
const POLL_MS = 5000;
const WINDOW_MS = 6 * 60_000;      // 6 minutes of tape on screen
const HORIZON_TICKS = 3;           // grade a call ~15s later
const EMA_ALPHA = 0.35;

type Tick = {
  t: number;
  bid: number;
  ask: number;
  bidSize: number;
  askSize: number;
  mid: number;
  micro: number;
  spread: number;
  obi: number;        // -1..1
  obiEma: number;     // smoothed
  skew: number;       // (micro-mid)/spread, roughly -0.5..0.5
  score: number;      // -1..1 blended pressure
  call: "UP" | "DOWN" | "FLAT";
  graded?: "hit" | "miss" | null;
};

type Props = {
  symbol: string;
  tokens: SchwabTokens | null;
  onTokens: (t: SchwabTokens) => void;
  sharedAvailable?: boolean;
  onTokensInvalid?: () => void;
};

function fmtTime(ms: number): string {
  return new Date(ms).toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false,
  });
}
function fmtSize(v: number): string {
  if (v >= 1000) return `${(v / 1000).toFixed(1)}k`;
  return `${Math.round(v)}`;
}
function clamp(v: number): number { return Math.max(-1, Math.min(1, v)); }

function isDeadRefresh(msg: string): boolean {
  const m = msg.toLowerCase();
  return m.includes("invalid_grant") || m.includes("unsupported_token_type") || m.includes("expired or revoked");
}

export function QuotePressureChart({ symbol, tokens, onTokens, sharedAvailable = false, onTokensInvalid }: Props) {
  const fetchQuotes = useServerFn(getSchwabQuotes);
  const fetchSharedQuotes = useServerFn(getSharedSchwabQuotes);
  const refresh = useServerFn(refreshSchwabToken);

  const [ticks, setTicks] = useState<Tick[]>([]);
  const [status, setStatus] = useState("idle");
  const emaRef = useRef<number | null>(null);
  const symbolRef = useRef(symbol);
  const sharedFailRef = useRef(0);

  useEffect(() => {
    if (symbolRef.current !== symbol) {
      symbolRef.current = symbol;
      setTicks([]);
      emaRef.current = null;
    }
  }, [symbol]);

  useEffect(() => {
    if (!symbol) return;
    const useShared = !tokens?.access_token;
    if (useShared && !sharedAvailable) return;
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        let quotes: Record<string, { last: number | null; bid: number | null; ask: number | null; bidSize: number | null; askSize: number | null }> | null;
        if (useShared) {
          quotes = await fetchSharedQuotes({ data: { symbols: [symbol] } });
          if (!quotes) {
            sharedFailRef.current += 1;
            if (sharedFailRef.current >= 5) { setStatus("reconnect Schwab"); onTokensInvalid?.(); }
            else setStatus("shared feed hiccup — retrying…");
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
                  setStatus(sharedAvailable ? "switching to shared feed…" : "reconnect Schwab");
                  onTokensInvalid?.();
                  return;
                }
                throw re;
              }
              onTokens(fresh);
              token = fresh.access_token;
              quotes = await fetchQuotes({ data: { accessToken: token, symbols: [symbol] } });
            } else throw e;
          }
        }
        const q = quotes?.[symbol];
        const bid = q?.bid ?? null, ask = q?.ask ?? null;
        const bs = q?.bidSize ?? null, as = q?.askSize ?? null;
        if (bid == null || ask == null || ask <= bid || !bs || !as || bs <= 0 || as <= 0) {
          setStatus("waiting for two-sided quote…");
          return;
        }
        const mid = (bid + ask) / 2;
        const spread = ask - bid;
        const micro = (bid * as + ask * bs) / (bs + as);
        const obi = (bs - as) / (bs + as);
        const prevEma = emaRef.current;
        const obiEma = prevEma == null ? obi : prevEma + EMA_ALPHA * (obi - prevEma);
        emaRef.current = obiEma;
        const skew = spread > 0 ? (micro - mid) / spread : 0;

        setTicks((prev) => {
          // Recent mid drift (last ~30s) as a confirmation term.
          const recent = prev.slice(-6);
          const firstMid = recent[0]?.mid ?? mid;
          const drift = firstMid > 0 ? (mid - firstMid) / firstMid : 0;
          const momentum = clamp(drift / 0.0008);
          const score = clamp(0.45 * obiEma + 0.35 * clamp(skew * 2) + 0.20 * momentum);
          const call: Tick["call"] = score > 0.25 ? "UP" : score < -0.25 ? "DOWN" : "FLAT";

          const next: Tick = { t: Date.now(), bid, ask, bidSize: bs, askSize: as, mid, micro, spread, obi, obiEma, skew, score, call, graded: null };

          // Grade the call made HORIZON_TICKS ago against the mid now.
          const out = [...prev, next];
          const idx = out.length - 1 - HORIZON_TICKS;
          const target = idx >= 0 ? out[idx] : undefined;
          if (target && target.graded == null && target.call !== "FLAT") {
            const moved = mid - target.mid;
            const hit = target.call === "UP" ? moved > 0 : moved < 0;
            out[idx] = { ...target, graded: hit ? "hit" : "miss" };
          }
          return out.length > 200 ? out.slice(out.length - 200) : out;
        });
        setStatus("live");
      } catch (e) {
        setStatus(`error: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    tick();
    const id = setInterval(tick, POLL_MS);
    return () => { cancelled = true; clearInterval(id); };
  }, [symbol, tokens, sharedAvailable, fetchQuotes, fetchSharedQuotes, refresh, onTokens, onTokensInvalid]);

  const [nowTick, setNowTick] = useState(Date.now());
  useEffect(() => {
    const id = setInterval(() => setNowTick(Date.now()), POLL_MS);
    return () => clearInterval(id);
  }, []);

  const visible = useMemo(() => ticks.filter((t) => t.t >= nowTick - WINDOW_MS), [ticks, nowTick]);

  const latest = visible[visible.length - 1] ?? null;

  const accuracy = useMemo(() => {
    let hit = 0, total = 0;
    for (const t of ticks) {
      if (t.graded === "hit") { hit++; total++; }
      else if (t.graded === "miss") total++;
    }
    return { hit, total, pct: total > 0 ? hit / total : null };
  }, [ticks]);

  const priceDomain = useMemo((): [number, number] => {
    if (visible.length === 0) return [0, 1];
    let lo = Infinity, hi = -Infinity;
    for (const t of visible) { lo = Math.min(lo, t.bid); hi = Math.max(hi, t.ask); }
    const pad = Math.max((hi - lo) * 0.25, hi * 0.0004);
    return [lo - pad, hi + pad];
  }, [visible]);

  const chartData = visible;

  const callColor = latest?.call === "UP" ? "#39d353" : latest?.call === "DOWN" ? "#f85149" : "#8b949e";

  return (
    <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 10, marginBottom: 12 }}>
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", justifyContent: "space-between", marginBottom: 8 }}>
        <div style={{ fontSize: 10, color: "#79c0ff", letterSpacing: 1.5, fontWeight: 700 }}>
          ⚖️ QUOTE PRESSURE · BID/ASK IMBALANCE · {symbol}
        </div>
        <span style={{ fontFamily: mono, fontSize: 10, padding: "2px 6px", background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: status === "live" ? "#39d353" : "#e3b341" }}>
          {status === "live" ? "● LIVE 5s" : status.toUpperCase()}
        </span>
      </div>

      {/* Stat strip */}
      <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 6, marginBottom: 8 }}>
        <div style={{ padding: 6, background: "rgba(57,211,83,0.08)", border: "1px solid #39d353", borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>BID × SIZE</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#39d353", fontFamily: mono }}>
            {latest ? `${latest.bid.toFixed(2)} × ${fmtSize(latest.bidSize)}` : "—"}
          </div>
        </div>
        <div style={{ padding: 6, background: "rgba(248,81,73,0.08)", border: "1px solid #f85149", borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>ASK × SIZE</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#f85149", fontFamily: mono }}>
            {latest ? `${latest.ask.toFixed(2)} × ${fmtSize(latest.askSize)}` : "—"}
          </div>
        </div>
        <div style={{ padding: 6, background: "#010409", border: "1px solid #30363d", borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>IMBALANCE</div>
          <div style={{ fontSize: 12, fontWeight: 800, fontFamily: mono, color: (latest?.obiEma ?? 0) >= 0 ? "#39d353" : "#f85149" }}>
            {latest ? `${latest.obiEma >= 0 ? "+" : ""}${(latest.obiEma * 100).toFixed(0)}%` : "—"}
          </div>
        </div>
        <div style={{ padding: 6, background: "#010409", border: "1px solid #30363d", borderRadius: 4 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>SPREAD</div>
          <div style={{ fontSize: 12, fontWeight: 800, color: "#c9d1d9", fontFamily: mono }}>
            {latest ? `$${latest.spread.toFixed(2)}` : "—"}
          </div>
        </div>
      </div>

      {/* Prediction strip */}
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8, padding: "6px 8px", background: "#010409", borderRadius: 4, border: `1px solid ${callColor}` }}>
        <div style={{
          minWidth: 46, height: 26, borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center",
          fontFamily: mono, fontSize: 11, fontWeight: 900, background: callColor,
          color: latest?.call === "FLAT" || !latest ? "#0d1117" : "#010409",
        }}>
          {latest?.call ?? "—"}
        </div>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>NEXT ~15s (3 POLLS)</div>
          <div style={{ fontSize: 10, color: "#c9d1d9", fontFamily: mono, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
            {latest
              ? `micro ${latest.micro.toFixed(3)} vs mid ${latest.mid.toFixed(3)} · skew ${(latest.skew * 100).toFixed(0)}% of spread`
              : "building book history…"}
          </div>
        </div>
        <div style={{ marginLeft: "auto", textAlign: "right" }}>
          <div style={{ fontSize: 8, color: "#8b949e", letterSpacing: 1 }}>HIT RATE</div>
          <div style={{ fontSize: 12, fontWeight: 800, fontFamily: mono, color: (accuracy.pct ?? 0) >= 0.5 ? "#39d353" : "#e3b341" }}>
            {accuracy.pct == null ? "—" : `${Math.round(accuracy.pct * 100)}% (${accuracy.hit}/${accuracy.total})`}
          </div>
        </div>
      </div>

      {chartData.length < 2 ? (
        <div style={{ padding: 20, textAlign: "center", fontSize: 10, color: "#6e7681" }}>
          Waiting for quotes… (needs two 5s polls to compute pressure)
        </div>
      ) : (
        <>
          <div style={{ fontSize: 9, color: "#8b949e", fontFamily: mono, padding: "0 4px 2px" }}>
            MID vs MICROPRICE · price drifts toward the microprice
          </div>
          <ResponsiveContainer width="100%" height={170}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="t" type="number" scale="time" domain={[nowTick - WINDOW_MS, nowTick + 20_000]}
                tickFormatter={fmtTime} stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} allowDataOverflow />
              <YAxis domain={priceDomain} stroke="#8b949e" fontSize={9} width={58}
                tick={{ fontFamily: mono }} tickFormatter={(v: number) => `$${v.toFixed(2)}`} />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11, fontFamily: mono }}
                labelFormatter={(v: number) => fmtTime(v)}
                formatter={(val: unknown, name: string) => [`$${Number(val).toFixed(3)}`, name]} />
              <Line type="stepAfter" dataKey="ask" stroke="#f85149" strokeWidth={1} dot={false} isAnimationActive={false} strokeOpacity={0.5} />
              <Line type="stepAfter" dataKey="bid" stroke="#39d353" strokeWidth={1} dot={false} isAnimationActive={false} strokeOpacity={0.5} />
              <Line type="monotone" dataKey="mid" stroke="#58a6ff" strokeWidth={1.6} dot={false} isAnimationActive={false} />
              <Line type="monotone" dataKey="micro" stroke="#d2a8ff" strokeWidth={1.6} strokeDasharray="4 3" dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>

          <div style={{ fontSize: 9, color: "#8b949e", fontFamily: mono, padding: "6px 4px 2px" }}>
            PRESSURE · green = bid-heavy (buy pressure), red = ask-heavy (sell pressure)
          </div>
          <ResponsiveContainer width="100%" height={110}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 30, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="t" type="number" scale="time" domain={[nowTick - WINDOW_MS, nowTick + 20_000]}
                tickFormatter={fmtTime} stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} allowDataOverflow />
              <YAxis domain={[-1, 1]} stroke="#8b949e" fontSize={9} width={58}
                tick={{ fontFamily: mono }} tickFormatter={(v: number) => `${Math.round(v * 100)}%`} />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", fontSize: 11, fontFamily: mono }}
                labelFormatter={(v: number) => fmtTime(v)}
                formatter={(val: unknown, name: string) => [`${(Number(val) * 100).toFixed(0)}%`, name === "obi" ? "book imbalance" : "pressure score"]} />
              <ReferenceLine y={0} stroke="#30363d" />
              <ReferenceLine y={0.25} stroke="#39d353" strokeDasharray="2 4" strokeOpacity={0.5} />
              <ReferenceLine y={-0.25} stroke="#f85149" strokeDasharray="2 4" strokeOpacity={0.5} />
              <Bar dataKey="obi" isAnimationActive={false} maxBarSize={6}>
                {chartData.map((d) => (
                  <Cell key={d.t} fill={d.obi >= 0 ? "#39d353" : "#f85149"} fillOpacity={0.45} />
                ))}
              </Bar>
              <Line type="monotone" dataKey="score" stroke="#e3b341" strokeWidth={1.8} dot={false} isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>

          <div style={{ fontSize: 9, color: "#6e7681", fontFamily: mono, paddingTop: 6, lineHeight: 1.5 }}>
            Score = 45% smoothed book imbalance + 35% microprice skew + 20% mid drift. A call fires above ±25%
            and is graded against the mid three polls (~15s) later — the hit rate above is live, not simulated.
          </div>
        </>
      )}
    </div>
  );
}
