import { useState, useEffect, useRef } from "react";
import { Link } from "@tanstack/react-router";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getLiveQuotes } from "@/lib/quotes.functions";

function useInterpolatedSignal(
  rawValue: number,
  { wPrev = 0.25, wCurrent = 0.5, wNext = 0.25, threshold = 0.002 } = {},
) {
  const prevRef = useRef<number | null>(null);
  const historyRef = useRef<number[]>([]);
  const [signal, setSignal] = useState<"BUY" | "SELL" | "NEUTRAL">("NEUTRAL");
  const [smoothed, setSmoothed] = useState(rawValue);
  const [changePct, setChangePct] = useState(0);
  const [components, setComponents] = useState({ prev: rawValue, current: rawValue, projected: rawValue });

  useEffect(() => {
    if (prevRef.current === null) {
      prevRef.current = rawValue;
      historyRef.current = [rawValue];
      return;
    }
    const prev = prevRef.current;
    const current = rawValue;
    const projectedNext = current + (current - prev);
    const blended = prev * wPrev + current * wCurrent + projectedNext * wNext;
    const pct = (blended - prev) / Math.abs(prev || 1);
    setSmoothed(blended);
    setChangePct(pct);
    setComponents({ prev, current, projected: projectedNext });
    if (pct > threshold) setSignal("BUY");
    else if (pct < -threshold) setSignal("SELL");
    else setSignal("NEUTRAL");
    historyRef.current = [...historyRef.current.slice(-59), blended];
    prevRef.current = current;
  }, [rawValue, wPrev, wCurrent, wNext, threshold]);

  return { signal, smoothed, changePct, components, history: historyRef.current };
}


function Sparkline({ data, signal, width = 220, height = 48 }: { data: number[]; signal: string; width?: number; height?: number }) {
  if (data.length < 2) return null;
  const min = Math.min(...data);
  const max = Math.max(...data);
  const range = max - min || 1;
  const pts = data.map((v, i) => {
    const x = (i / (data.length - 1)) * width;
    const y = height - ((v - min) / range) * height;
    return `${x},${y}`;
  }).join(" ");
  const color = signal === "BUY" ? "#00ff9d" : signal === "SELL" ? "#ff3366" : "#4af";
  return (
    <svg width={width} height={height} style={{ overflow: "visible" }}>
      <defs>
        <linearGradient id={`sg-${signal}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor={color} stopOpacity="0.3" />
          <stop offset="100%" stopColor={color} stopOpacity="0.0" />
        </linearGradient>
        <filter id="glow">
          <feGaussianBlur stdDeviation="1.5" result="blur" />
          <feMerge><feMergeNode in="blur" /><feMergeNode in="SourceGraphic" /></feMerge>
        </filter>
      </defs>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.5" filter="url(#glow)" opacity="0.9" />
      <polygon points={`0,${height} ${pts} ${width},${height}`} fill={`url(#sg-${signal})`} />
    </svg>
  );
}

function WeightBar({ label, weight, value, color, tag }: { label: string; weight: number; value: number; color: string; tag: string }) {
  return (
    <div style={{ marginBottom: 8 }}>
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 3, fontSize: 10, letterSpacing: "0.12em", color: "#8899aa" }}>
        <span>{label} <span style={{ color: "#556", fontSize: 9 }}>{tag}</span></span>
        <span style={{ color: "#ccd" }}>{value?.toFixed(2)} <span style={{ color: "#556" }}>w:{(weight * 100).toFixed(0)}%</span></span>
      </div>
      <div style={{ height: 4, background: "#111a24", borderRadius: 2, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${weight * 100}%`, background: color, borderRadius: 2, transition: "width 0.4s ease", boxShadow: `0 0 6px ${color}88` }} />
      </div>
    </div>
  );
}

function SignalBadge({ signal, changePct }: { signal: "BUY" | "SELL" | "NEUTRAL"; changePct: number }) {
  const cfg = {
    BUY: { color: "#00ff9d", bg: "#00ff9d18", border: "#00ff9d44", label: "◈ ACCUMULATE", icon: "▲" },
    SELL: { color: "#ff3366", bg: "#ff336618", border: "#ff336644", label: "◈ DISTRIBUTE", icon: "▼" },
    NEUTRAL: { color: "#44aaff", bg: "#44aaff12", border: "#44aaff33", label: "◈ HOLD", icon: "◆" },
  }[signal];
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "10px 18px", borderRadius: 6, background: cfg.bg, border: `1px solid ${cfg.border}`, boxShadow: `0 0 20px ${cfg.color}22`, transition: "all 0.5s ease" }}>
      <span style={{ fontSize: 22, color: cfg.color, filter: `drop-shadow(0 0 6px ${cfg.color})`, fontWeight: 900 }}>{cfg.icon}</span>
      <div>
        <div style={{ fontSize: 13, fontWeight: 700, color: cfg.color, letterSpacing: "0.18em", fontFamily: "'Courier New', monospace" }}>{cfg.label}</div>
        <div style={{ fontSize: 10, color: "#667788", marginTop: 1, letterSpacing: "0.1em" }}>Δ {changePct >= 0 ? "+" : ""}{(changePct * 100).toFixed(4)}%</div>
      </div>
    </div>
  );
}

function TickerPanel({ ticker, basePrice, weights, threshold }: { ticker: string; basePrice: number; weights: { prev: number; current: number; next: number }; threshold: number }) {
  const { price } = useSimulatedFutures(ticker, basePrice);
  const { signal, smoothed, changePct, components, history } = useInterpolatedSignal(price, { wPrev: weights.prev, wCurrent: weights.current, wNext: weights.next, threshold });
  const signalColor = signal === "BUY" ? "#00ff9d" : signal === "SELL" ? "#ff3366" : "#44aaff";
  return (
    <div style={{ background: "linear-gradient(135deg, #0a1018 0%, #0d1520 100%)", border: `1px solid ${signalColor}22`, borderTop: `2px solid ${signalColor}66`, borderRadius: 8, padding: "16px 18px", marginBottom: 12, boxShadow: `0 4px 24px #00000066, inset 0 1px 0 ${signalColor}11`, transition: "border-color 0.6s ease", position: "relative", overflow: "hidden" }}>
      <div style={{ position: "absolute", inset: 0, backgroundImage: "linear-gradient(#ffffff04 1px, transparent 1px), linear-gradient(90deg, #ffffff04 1px, transparent 1px)", backgroundSize: "20px 20px", pointerEvents: "none" }} />
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12, position: "relative" }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 700, color: "#ccd", letterSpacing: "0.2em", fontFamily: "'Courier New', monospace" }}>{ticker}</div>
          <div style={{ fontSize: 22, fontWeight: 800, color: "#eef", fontFamily: "'Courier New', monospace", lineHeight: 1.1 }}>
            ${price.toFixed(2)}
            <span style={{ fontSize: 11, color: signalColor, marginLeft: 8, fontWeight: 400 }}>→ {smoothed.toFixed(2)}</span>
          </div>
        </div>
        <Sparkline data={history} signal={signal} />
      </div>
      <div style={{ marginBottom: 14 }}><SignalBadge signal={signal} changePct={changePct} /></div>
      <div style={{ borderTop: "1px solid #1a2535", paddingTop: 12 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#445566", marginBottom: 8 }}>3-WINDOW INTERPOLATION</div>
        <WeightBar label="PREV  [t-10s]" tag="past" weight={weights.prev} value={components.prev} color="#4488cc" />
        <WeightBar label="NOW   [t±0]" tag="current" weight={weights.current} value={components.current} color={signalColor} />
        <WeightBar label="PROJ  [t+10s]" tag="forecast" weight={weights.next} value={components.projected} color="#cc8844" />
      </div>
    </div>
  );
}

const FUTURES_TICKERS = [
  { ticker: "ES", label: "S&P 500 Futures", basePrice: 5310.25 },
  { ticker: "NQ", label: "Nasdaq Futures", basePrice: 18742.5 },
  { ticker: "YM", label: "Dow Futures", basePrice: 39250.0 },
  { ticker: "RTY", label: "Russell 2K Futures", basePrice: 2080.0 },
];

export type InterpolatorTicker = { ticker: string; label?: string; basePrice: number };

export function SignalInterpolator({
  tickers,
  title = "SIGNAL INTERPOLATOR",
  subtitle = "BRYANTRADE · INTERPOLATOR MODULE",
  defaultActive,
}: {
  tickers: InterpolatorTicker[];
  title?: string;
  subtitle?: string;
  defaultActive?: string[];
}) {
  const [weights, setWeights] = useState({ prev: 0.25, current: 0.5, next: 0.25 });
  const [threshold, setThreshold] = useState(0.002);
  const [activeTickers, setActiveTickers] = useState<string[]>(
    defaultActive ?? tickers.slice(0, Math.min(6, tickers.length)).map((t) => t.ticker),
  );
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const t = setInterval(() => setElapsed((e) => e + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const setWeight = (key: "prev" | "current" | "next", val: number) => {
    setWeights((w) => {
      const newW = { ...w, [key]: val };
      const others = (["prev", "current", "next"] as const).filter((k) => k !== key);
      const rem = 1 - val;
      const ratio = w[others[0]] + w[others[1]] || 0.5;
      newW[others[0]] = +(rem * (w[others[0]] / ratio)).toFixed(2);
      newW[others[1]] = +(1 - val - newW[others[0]]).toFixed(2);
      return newW;
    });
  };

  const toggleTicker = (t: string) => setActiveTickers((a) => (a.includes(t) ? a.filter((x) => x !== t) : [...a, t]));

  return (
    <div style={{ minHeight: "100vh", background: "#070c12", fontFamily: "'Courier New', Courier, monospace", color: "#ccd", padding: "20px 16px" }}>
      <div style={{ marginBottom: 20, borderBottom: "1px solid #1a2535", paddingBottom: 14 }}>
        <Link
          to="/"
          style={{
            display: "inline-block",
            marginBottom: 12,
            padding: "6px 12px",
            border: "1px solid #1a2535",
            borderRadius: 6,
            color: "#44aaff",
            textDecoration: "none",
            fontSize: 11,
            letterSpacing: "0.15em",
          }}
        >
          ← BACK TO TERMINAL
        </Link>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <div>
            <div style={{ fontSize: 11, letterSpacing: "0.3em", color: "#445566", marginBottom: 2 }}>{subtitle}</div>
            <div style={{ fontSize: 20, fontWeight: 800, color: "#eef", letterSpacing: "0.15em" }}>{title} <span style={{ color: "#44aaff", fontSize: 12 }}>v2.1</span></div>
          </div>
          <div style={{ textAlign: "right", fontSize: 10, color: "#334455" }}>
            <div style={{ color: "#00ff9d", fontSize: 11 }}>● LIVE</div>
            <div>T+{elapsed}s</div>
            <div>10s POLL</div>
          </div>
        </div>
      </div>

      <div style={{ background: "#0a1018", border: "1px solid #1a2535", borderRadius: 8, padding: "14px 16px", marginBottom: 16 }}>
        <div style={{ fontSize: 9, letterSpacing: "0.2em", color: "#445566", marginBottom: 12 }}>INTERPOLATION WEIGHTS</div>
        {[
          { key: "prev" as const, label: "PREV [t-10s]", color: "#4488cc" },
          { key: "current" as const, label: "NOW  [t±0]", color: "#00ff9d" },
          { key: "next" as const, label: "PROJ [t+10s]", color: "#cc8844" },
        ].map(({ key, label, color }) => (
          <div key={key} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
            <span style={{ width: 90, fontSize: 9, color, letterSpacing: "0.12em" }}>{label}</span>
            <input type="range" min="0.05" max="0.80" step="0.05" value={weights[key]} onChange={(e) => setWeight(key, parseFloat(e.target.value))} style={{ flex: 1, accentColor: color, cursor: "pointer" }} />
            <span style={{ width: 36, fontSize: 11, color: "#aab", textAlign: "right" }}>{(weights[key] * 100).toFixed(0)}%</span>
          </div>
        ))}
        <div style={{ display: "flex", alignItems: "center", gap: 10, marginTop: 10, paddingTop: 10, borderTop: "1px solid #1a2535" }}>
          <span style={{ width: 90, fontSize: 9, color: "#ff9944", letterSpacing: "0.12em" }}>THRESHOLD</span>
          <input type="range" min="0.0005" max="0.01" step="0.0005" value={threshold} onChange={(e) => setThreshold(parseFloat(e.target.value))} style={{ flex: 1, accentColor: "#ff9944", cursor: "pointer" }} />
          <span style={{ width: 50, fontSize: 11, color: "#aab", textAlign: "right" }}>{(threshold * 100).toFixed(3)}%</span>
        </div>
        <div style={{ fontSize: 9, color: "#334455", marginTop: 6, letterSpacing: "0.1em" }}>↑ higher threshold = fewer signals · lower = more sensitive</div>
      </div>

      <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 16 }}>
        {tickers.map(({ ticker }) => {
          const active = activeTickers.includes(ticker);
          return (
            <button key={ticker} onClick={() => toggleTicker(ticker)} style={{ padding: "4px 12px", fontSize: 9, letterSpacing: "0.15em", background: active ? "#44aaff22" : "#0a1018", border: `1px solid ${active ? "#44aaff55" : "#1a2535"}`, borderRadius: 4, color: active ? "#44aaff" : "#445566", cursor: "pointer", transition: "all 0.2s", fontFamily: "'Courier New', monospace" }}>
              {ticker}
            </button>
          );
        })}
      </div>

      {tickers.filter((t) => activeTickers.includes(t.ticker)).map(({ ticker, basePrice }) => (
        <TickerPanel key={ticker} ticker={ticker} basePrice={basePrice} weights={weights} threshold={threshold} />
      ))}

      {activeTickers.length === 0 && (
        <div style={{ textAlign: "center", color: "#334455", padding: "40px 0", fontSize: 12, letterSpacing: "0.2em" }}>SELECT A TICKER ABOVE TO BEGIN</div>
      )}

      <div style={{ marginTop: 16, padding: "12px 16px", background: "#0a1018", border: "1px solid #1a2535", borderRadius: 8, fontSize: 9, color: "#334455", letterSpacing: "0.12em", lineHeight: 1.8 }}>
        <div style={{ color: "#445566", marginBottom: 4 }}>HOW IT WORKS</div>
        <div>BLENDED = (PREV × {(weights.prev * 100).toFixed(0)}%) + (NOW × {(weights.current * 100).toFixed(0)}%) + (PROJ × {(weights.next * 100).toFixed(0)}%)</div>
        <div>PROJ = NOW + (NOW − PREV) · linear momentum extrapolation</div>
        <div>SIGNAL fires when Δ blended/prev {">"} ±{(threshold * 100).toFixed(3)}%</div>
      </div>
    </div>
  );
}

export default function FuturesSignalInterpolator() {
  return (
    <SignalInterpolator
      tickers={FUTURES_TICKERS}
      title="FUTURES INTERPOLATOR"
      subtitle="BRYANTRADE · FUTURES MODULE"
      defaultActive={FUTURES_TICKERS.map((t) => t.ticker)}
    />
  );
}