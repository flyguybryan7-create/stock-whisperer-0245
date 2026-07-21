import { useEffect, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ResponsiveContainer, AreaChart, Area, XAxis, YAxis, CartesianGrid, Tooltip, ReferenceLine,
} from "recharts";
import { getIntraday } from "@/lib/quotes.functions";

const mono = "SF Mono, Menlo, monospace";

type Bar = { t: number; open: number; high: number; low: number; close: number; volume: number };

type Props = {
  label: string;      // display name e.g. "SOX"
  fullName?: string;  // e.g. "PHLX Semiconductor Index"
  symbol: string;     // Yahoo symbol e.g. "^SOX"
  onClose: () => void;
};

function fmtTime(ts: number): string {
  return new Date(ts * 1000).toLocaleTimeString("en-US", {
    timeZone: "America/New_York", hour: "numeric", minute: "2-digit",
  });
}

export function IndexChartModal({ label, fullName, symbol, onClose }: Props) {
  const getIntradayFn = useServerFn(getIntraday);
  const [bars, setBars] = useState<Bar[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [range, setRange] = useState<"1d" | "2d" | "5d">("1d");

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const data = await getIntradayFn({ data: { symbol, interval: range === "5d" ? "5m" : "1m", range } });
        if (cancelled) return;
        setBars(data);
        setErr(null);
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : "Failed to load chart");
      }
    }
    setBars(null);
    load();
    const id = setInterval(load, 15_000);
    return () => { cancelled = true; clearInterval(id); };
  }, [symbol, range, getIntradayFn]);

  const last = bars && bars.length ? bars[bars.length - 1].close : null;
  const first = bars && bars.length ? bars[0].open : null;
  const change = last != null && first != null ? last - first : null;
  const changePct = last != null && first != null && first !== 0 ? ((last - first) / first) * 100 : null;
  const up = (change ?? 0) >= 0;
  const color = up ? "#39d353" : "#f85149";

  return (
    <div
      role="dialog"
      aria-modal="true"
      style={{
        position: "fixed", inset: 0, zIndex: 1000, background: "#010409",
        display: "flex", flexDirection: "column", overflow: "hidden",
      }}
    >
      {/* Header with back button */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 12px", borderBottom: "1px solid #21262d", background: "#0d1117", flexShrink: 0 }}>
        <button
          type="button"
          onClick={onClose}
          style={{ background: "rgba(88,166,255,0.12)", border: "1px solid #58a6ff", color: "#58a6ff", fontSize: 11, fontWeight: 800, padding: "6px 12px", borderRadius: 5, cursor: "pointer", fontFamily: mono, letterSpacing: 0.5 }}
        >
          ← BACK
        </button>
        <div style={{ textAlign: "center", flex: 1, padding: "0 8px", overflow: "hidden" }}>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#e6edf3", fontFamily: mono, letterSpacing: 0.5 }}>
            {label} {last != null && <span style={{ color }}>· {last.toFixed(2)}</span>}
          </div>
          {fullName && <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>{fullName}</div>}
        </div>
        <div style={{ display: "flex", gap: 4 }}>
          {(["1d","2d","5d"] as const).map((r) => (
            <button key={r} type="button" onClick={() => setRange(r)}
              style={{
                background: range === r ? "#58a6ff" : "transparent",
                border: "1px solid #30363d", color: range === r ? "#0d1117" : "#8b949e",
                fontSize: 10, fontWeight: 800, padding: "4px 8px", borderRadius: 4,
                cursor: "pointer", fontFamily: mono,
              }}>{r.toUpperCase()}</button>
          ))}
        </div>
      </div>

      {/* Stats bar */}
      {change != null && changePct != null && (
        <div style={{ padding: "6px 12px", borderBottom: "1px solid #21262d", background: "#0d1117", fontFamily: mono, fontSize: 11, color, fontWeight: 700, flexShrink: 0 }}>
          {up ? "▲" : "▼"} {change >= 0 ? "+" : ""}{change.toFixed(2)} ({changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%)
          <span style={{ color: "#6e7681", marginLeft: 10, fontWeight: 400 }}>· auto-refresh 15s</span>
        </div>
      )}

      {/* Chart */}
      <div style={{ flex: 1, minHeight: 0, padding: 8, background: "#0d1117" }}>
        {err ? (
          <div style={{ padding: 20, color: "#f85149", fontFamily: mono, fontSize: 11 }}>Error: {err}</div>
        ) : bars == null ? (
          <div style={{ padding: 20, color: "#8b949e", fontFamily: mono, fontSize: 11 }}>Loading intraday chart…</div>
        ) : bars.length === 0 ? (
          <div style={{ padding: 20, color: "#8b949e", fontFamily: mono, fontSize: 11 }}>No intraday data available for {symbol}.</div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={bars} margin={{ top: 10, right: 12, left: 0, bottom: 10 }}>
              <defs>
                <linearGradient id="gradIdx" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor={color} stopOpacity={0.5} />
                  <stop offset="100%" stopColor={color} stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="t" tickFormatter={fmtTime} stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} minTickGap={40} />
              <YAxis domain={["auto", "auto"]} stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} width={56} tickFormatter={(v) => v.toFixed(2)} />
              <Tooltip
                contentStyle={{ background: "#161b22", border: "1px solid #30363d", borderRadius: 4, fontFamily: mono, fontSize: 11 }}
                labelFormatter={(v) => fmtTime(Number(v))}
                formatter={(v: number) => [v.toFixed(2), "Price"]}
              />
              {first != null && <ReferenceLine y={first} stroke="#484f58" strokeDasharray="2 4" />}
              <Area type="monotone" dataKey="close" stroke={color} strokeWidth={2} fill="url(#gradIdx)" isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        )}
      </div>
    </div>
  );
}