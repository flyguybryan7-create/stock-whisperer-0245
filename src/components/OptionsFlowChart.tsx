import { useEffect, useMemo, useState } from "react";
import {
  ComposedChart, Bar, XAxis, YAxis, CartesianGrid, Cell,
  ReferenceLine, ReferenceDot, ResponsiveContainer, LabelList,
} from "recharts";
import type { SchwabOptionsLadder } from "@/lib/schwab.functions";

const mono = "SF Mono, Menlo, monospace";

function timeToClose(now: Date): string {
  // Regular US session close is 16:00 ET. Convert current time to ET.
  const et = new Date(now.toLocaleString("en-US", { timeZone: "America/New_York" }));
  const close = new Date(et);
  close.setHours(16, 0, 0, 0);
  const diff = close.getTime() - et.getTime();
  if (diff <= 0) return "CLOSED";
  const h = Math.floor(diff / 3600000);
  const m = Math.floor((diff % 3600000) / 60000);
  return `${h}h ${m}m`;
}

function fmtVol(v: number): string {
  if (v >= 1e6) return `${(v / 1e6).toFixed(1)}M`;
  if (v >= 1e3) return `${(v / 1e3).toFixed(1)}k`;
  return `${v}`;
}

function fmtAsOf(iso: string): string {
  // CBOE's last_trade_time is naive ET ("YYYY-MM-DDTHH:MM:SS" with no tz).
  // Treat unqualified timestamps as already-ET so we don't shift by the UTC offset.
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})[T ](\d{2}):(\d{2})/);
  if (!hasTz && m) {
    const months = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
    let h = Number(m[4]);
    const ampm = h >= 12 ? "PM" : "AM";
    h = h % 12 || 12;
    return `${months[Number(m[2]) - 1]} ${Number(m[3])}, ${h}:${m[5]} ${ampm} ET`;
  }
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString("en-US", {
    timeZone: "America/New_York",
    month: "short", day: "numeric",
    hour: "numeric", minute: "2-digit",
  }) + " ET";
}

function isPriorSessionET(iso: string): boolean {
  const hasTz = /(Z|[+-]\d{2}:?\d{2})$/.test(iso);
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  let feedDay: string;
  if (!hasTz && m) {
    feedDay = `${m[1]}-${m[2]}-${m[3]}`;
  } else {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return false;
    feedDay = d.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  }
  const today = new Date().toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  return feedDay < today;
}

type Props = {
  symbol: string;
  spot: number | null;
  ladder: SchwabOptionsLadder | null;
  expiryIndex?: number;
  onExpiryChange?: (index: number) => void;
};

export function OptionsFlowChart({ symbol, spot, ladder, expiryIndex = 0, onExpiryChange }: Props) {
  // Live clock for the time-to-close readout — ticks every 30s.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  const data = useMemo(() => {
    if (!ladder?.ladder?.length) return [];
    return ladder.ladder.map((r) => ({
      strike: r.strike,
      strikeLabel: `$${r.strike}`,
      // Put volume drawn as negative so it points left of the zero axis;
      // call volume points right. That gives you the classic "flow ladder".
      putVolNeg: -r.putVol,
      callVol: r.callVol,
      putVol: r.putVol,
    }));
  }, [ladder]);

  const magnet = useMemo(() => {
    if (!ladder) return null;
    const c = ladder.magnetCall?.volume ?? 0;
    const p = ladder.magnetPut?.volume ?? 0;
    if (c === 0 && p === 0) return null;
    return c >= p ? {
      side: "CALL" as const,
      strike: ladder.magnetCall!.strike,
      pct: ladder.magnetCall!.pct,
      volume: ladder.magnetCall!.volume,
    } : {
      side: "PUT" as const,
      strike: ladder.magnetPut!.strike,
      pct: ladder.magnetPut!.pct,
      volume: ladder.magnetPut!.volume,
    };
  }, [ladder]);

  const distance = magnet && spot ? magnet.strike - spot : null;
  const distancePct = magnet && spot ? ((magnet.strike - spot) / spot) * 100 : null;

  const maxVol = useMemo(() => {
    if (!data.length) return 0;
    let m = 0;
    for (const d of data) m = Math.max(m, d.callVol, d.putVol);
    return m;
  }, [data]);

  const noWeeklies = ladder && !ladder.hasWeeklies;
  const empty = !ladder || !data.length;

  return (
    <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 10, marginBottom: 12 }}>
      {/* Header — magnet callout keeps target strike centered and readable */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8, justifyContent: "space-between" }}>
        <div style={{ fontSize: 10, color: "#d2a8ff", letterSpacing: 1.5, fontWeight: 700 }}>
          ⚡ OPTIONS FLOW MAGNET · {symbol}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: mono, fontSize: 10 }}>
          {ladder?.alternateExpiries && ladder.alternateExpiries.length > 1 && onExpiryChange ? (
            <select
              value={Math.min(expiryIndex, ladder.alternateExpiries.length - 1)}
              onChange={(e) => onExpiryChange(Number(e.target.value))}
              style={{
                padding: "2px 6px", background: "#161b22", border: "1px solid #30363d", borderRadius: 4,
                color: "#d2a8ff", fontFamily: mono, fontSize: 10, fontWeight: 700, cursor: "pointer", outline: "none",
              }}
              aria-label="Select expiry"
            >
              {ladder.alternateExpiries.map((e, i) => (
                <option key={e.expiry} value={i}>
                  EXP {e.label}{e.dte != null ? ` · ${e.dte}D` : ""}
                </option>
              ))}
            </select>
          ) : ladder?.label ? (
            <span style={{ padding: "2px 6px", background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#8b949e" }}>
              EXP {ladder.label}{ladder.dte != null && ` · ${ladder.dte}D`}
            </span>
          ) : null}
          <span style={{ padding: "2px 6px", background: "#161b22", border: "1px solid #21262d", borderRadius: 4, color: "#e3b341" }}>
            CLOSE IN {timeToClose(now)}
          </span>
        </div>
      </div>

      {noWeeklies && (
        <div style={{ padding: 8, marginBottom: 8, background: "#161b22", border: "1px solid #30363d", borderRadius: 4, fontSize: 10, color: "#e3b341" }}>
          ⚠ {symbol} has no weekly options — showing nearest monthly expiry ({ladder?.dte}D).
        </div>
      )}

      {ladder?.asOf && isPriorSessionET(ladder.asOf) && (
        <div style={{ padding: 8, marginBottom: 8, background: "#161b22", border: "1px solid #e3b341", borderRadius: 4, fontSize: 10, color: "#e3b341" }}>
          ⚠ Public options feed hasn't rolled to today's session yet (last trade {fmtAsOf(ladder.asOf)}). Showing open-interest magnet until today's volume prints.
        </div>
      )}
      {ladder?.asOf && !isPriorSessionET(ladder.asOf) && (
        <div style={{ fontSize: 9, color: "#6e7681", fontFamily: mono, padding: "0 2px 6px" }}>
          Feed as of {fmtAsOf(ladder.asOf)} · public options data is 15-min delayed
        </div>
      )}

      {/* Magnet strike centerpiece — the "where flow is going" callout */}
      {magnet && (
        <div style={{
          display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8, marginBottom: 10,
          padding: 10, background: magnet.side === "CALL" ? "rgba(57,211,83,0.08)" : "rgba(248,81,73,0.08)",
          border: `1px solid ${magnet.side === "CALL" ? "#39d353" : "#f85149"}`, borderRadius: 6,
        }}>
          <div>
            <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>MAGNET STRIKE</div>
            <div style={{ fontSize: 22, fontWeight: 800, fontFamily: mono, color: magnet.side === "CALL" ? "#39d353" : "#f85149" }}>
              {magnet.side} ${magnet.strike}
            </div>
            <div style={{ fontSize: 9, color: "#8b949e", fontFamily: mono }}>
              {fmtVol(magnet.volume)} contracts · {(magnet.pct * 100).toFixed(1)}% of {magnet.side.toLowerCase()} flow
            </div>
          </div>
          <div style={{ textAlign: "right" }}>
            <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>SPOT vs TARGET</div>
            <div style={{ fontSize: 18, fontWeight: 700, fontFamily: mono, color: "#c9d1d9" }}>
              {spot != null ? `$${spot.toFixed(2)}` : "—"}
            </div>
            {distance != null && distancePct != null && (
              <div style={{ fontSize: 11, fontFamily: mono, color: distance >= 0 ? "#39d353" : "#f85149", fontWeight: 700 }}>
                {distance >= 0 ? "▲" : "▼"} ${Math.abs(distance).toFixed(2)} ({distancePct >= 0 ? "+" : ""}{distancePct.toFixed(2)}%)
              </div>
            )}
          </div>
        </div>
      )}

      {empty ? (
        <div style={{ padding: 20, textAlign: "center", fontSize: 10, color: "#6e7681" }}>
          {ladder === null ? "Loading options flow…" : "No option activity yet for the nearest expiry."}
        </div>
      ) : (
        <>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: "#8b949e", fontFamily: mono, padding: "0 4px 4px" }}>
            <span>◀ PUT FLOW · {fmtVol(ladder!.putVolume)}</span>
            <span style={{ color: "#c9d1d9" }}>STRIKE</span>
            <span>CALL FLOW · {fmtVol(ladder!.callVolume)} ▶</span>
          </div>
          {/* Horizontal ladder — puts left (red), calls right (green),
              zero axis is strike price. Spot marked with a horizontal line. */}
          <ResponsiveContainer width="100%" height={Math.max(220, data.length * 20)}>
            <ComposedChart data={data} layout="vertical" margin={{ top: 4, right: 56, left: 56, bottom: 8 }} stackOffset="sign">
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" horizontal={false} />
              <XAxis type="number" domain={[-maxVol * 1.2, maxVol * 1.2]} tickFormatter={(v: number) => fmtVol(Math.abs(v))} stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
              <YAxis type="category" dataKey="strikeLabel" stroke="#8b949e" fontSize={10} tick={{ fontFamily: mono, fontWeight: 600 }} width={56} reversed />
              <ReferenceLine x={0} stroke="#484f58" />
              {spot != null && (() => {
                // Find the closest strike category to spot to anchor the spot marker.
                let closest = data[0];
                let bestDelta = Math.abs(data[0].strike - spot);
                for (const d of data) {
                  const delta = Math.abs(d.strike - spot);
                  if (delta < bestDelta) { bestDelta = delta; closest = d; }
                }
                return (
                  <ReferenceLine
                    y={closest.strikeLabel}
                    stroke="#58a6ff"
                    strokeWidth={2}
                    strokeDasharray="4 2"
                    label={{ value: `SPOT $${spot.toFixed(2)}`, position: "right", fill: "#58a6ff", fontSize: 10, fontWeight: 700, fontFamily: mono }}
                  />
                );
              })()}
              <Bar dataKey="putVolNeg" name="Puts" isAnimationActive={false} maxBarSize={14}>
                {data.map((d, i) => (
                  <Cell key={`p${i}`} fill={magnet?.side === "PUT" && d.strike === magnet.strike ? "#f85149" : "#8b3b3b"} />
                ))}
                <LabelList dataKey="putVol" position="left" fill="#f85149" fontSize={9} fontFamily={mono} offset={4}
                  formatter={(v: number) => (v > 0 ? fmtVol(v) : "")} />
              </Bar>
              <Bar dataKey="callVol" name="Calls" isAnimationActive={false} maxBarSize={14}>
                {data.map((d, i) => (
                  <Cell key={`c${i}`} fill={magnet?.side === "CALL" && d.strike === magnet.strike ? "#39d353" : "#3b7a4b"} />
                ))}
                <LabelList dataKey="callVol" position="right" fill="#39d353" fontSize={9} fontFamily={mono} offset={4}
                  formatter={(v: number) => (v > 0 ? fmtVol(v) : "")} />
              </Bar>
              {magnet && (
                <ReferenceDot x={magnet.side === "CALL" ? magnet.volume : -magnet.volume} y={`$${magnet.strike}`} r={5}
                  fill={magnet.side === "CALL" ? "#39d353" : "#f85149"} stroke="#0d1117" strokeWidth={2} isFront />
              )}
            </ComposedChart>
          </ResponsiveContainer>
          <div style={{ fontSize: 9, color: "#6e7681", textAlign: "center", padding: "4px 0 0" }}>
            {ladder?.source === "oi"
              ? "Open interest positioning · magnet strike = heaviest OI concentration"
              : "Cumulative session option volume · refreshes every 10s · magnet strike = heaviest volume concentration"}
          </div>
        </>
      )}
    </div>
  );
}