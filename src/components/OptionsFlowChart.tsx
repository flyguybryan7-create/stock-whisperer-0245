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
  return `${Math.round(v)}`;
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
  /** Timestamp of the last successful poll. */
  updatedAt?: number | null;
  /** Contracts added since the previous poll. */
  deltaCall?: number;
  deltaPut?: number;
};

export function OptionsFlowChart({ symbol, spot, ladder, expiryIndex = 0, onExpiryChange, updatedAt = null, deltaCall = 0, deltaPut = 0 }: Props) {
  // "day"  = today's option volume only (resets each session)
  // "cum"  = open interest: every contract still held from prior days/weeks,
  //          i.e. the accumulated positioning built up before today.
  const [mode, setMode] = useState<"day" | "cum">("cum");
  // Live clock for the time-to-close readout — ticks every 30s.
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), 5_000);
    return () => clearInterval(id);
  }, []);

  const data = useMemo(() => {
    if (!ladder?.ladder?.length) return [];
    return ladder.ladder.map((r) => {
      const c = mode === "cum" ? r.callOi : r.callVol;
      const p = mode === "cum" ? r.putOi : r.putVol;
      return {
        strike: r.strike,
        strikeLabel: `$${r.strike}`,
        // Put volume drawn as negative so it points left of the zero axis;
        // call volume points right. That gives you the classic "flow ladder".
        putVolNeg: -p,
        callVol: c,
        putVol: p,
      };
    });
  }, [ladder, mode]);

  // Totals for the selected mode.
  const totals = useMemo(() => {
    let call = 0, put = 0;
    for (const d of data) { call += d.callVol; put += d.putVol; }
    if (mode === "day" && ladder) {
      call = Math.max(call, ladder.callVolume);
      put = Math.max(put, ladder.putVolume);
    }
    return { call, put };
  }, [data, mode, ladder]);

  // Estimated buy vs sell split (Lee-Ready on the chain snapshot). Only
  // meaningful for traded volume, so it's hidden in cumulative/OI mode.
  const flowSide = useMemo(() => {
    const cb = ladder?.callBuyVolume ?? 0;
    const cs = ladder?.callSellVolume ?? 0;
    const pb = ladder?.putBuyVolume ?? 0;
    const ps = ladder?.putSellVolume ?? 0;
    if (cb + cs + pb + ps <= 0) return null;
    return {
      cb, cs, pb, ps,
      callBuyPct: cb + cs > 0 ? cb / (cb + cs) : 0,
      putBuyPct: pb + ps > 0 ? pb / (pb + ps) : 0,
    };
  }, [ladder]);

  const magnet = useMemo(() => {
    if (!data.length) return null;
    // The "target strike" must be a plausible price magnet, not a deep OTM
    // hedge/spread leg — but the band was so tight it hid the true heaviest
    // strike just outside it (e.g. $100 on an $88 spot). Widen to a realistic
    // expected-move window: ≈±15% for weeklies, up to ±30% for far-dated.
    const dte = Math.max(0, ladder?.dte ?? 0);
    const band = Math.min(0.3, Math.max(0.15, 0.12 + 0.02 * Math.sqrt(dte)));
    const inBand = spot && spot > 0
      ? data.filter((d) => Math.abs(d.strike - spot) / spot <= band)
      : data;
    const pool = inBand.length ? inBand : data;
    let bestC = { strike: 0, volume: 0 };
    let bestP = { strike: 0, volume: 0 };
    for (const d of pool) {
      if (d.callVol > bestC.volume) bestC = { strike: d.strike, volume: d.callVol };
      if (d.putVol > bestP.volume) bestP = { strike: d.strike, volume: d.putVol };
    }
    if (bestC.volume === 0 && bestP.volume === 0) return null;
    return bestC.volume >= bestP.volume
      ? { side: "CALL" as const, strike: bestC.strike, volume: bestC.volume, pct: totals.call > 0 ? bestC.volume / totals.call : 0 }
      : { side: "PUT" as const, strike: bestP.strike, volume: bestP.volume, pct: totals.put > 0 ? bestP.volume / totals.put : 0 };
  }, [data, totals, spot, ladder?.dte]);

  const distance = magnet && spot ? magnet.strike - spot : null;
  const distancePct = magnet && spot ? ((magnet.strike - spot) / spot) * 100 : null;

  const maxVol = useMemo(() => {
    if (!data.length) return 0;
    let m = 0;
    for (const d of data) m = Math.max(m, d.callVol, d.putVol);
    return m;
  }, [data]);

  // "No weeklies" means the entire chain lacks any near-term (≤10 DTE) expiry.
  // Do NOT flag it just because the user picked a farther-out expiry from the
  // dropdown — Schwab returns Jul 24, Jul 31, Aug 7, Aug 14 … all weeklies for
  // most large-caps, so a mid-cycle Aug 14 selection is not "no weeklies".
  const chainHasWeeklies = ladder?.alternateExpiries?.some(
    (e) => typeof e.dte === "number" && e.dte <= 10,
  ) || (typeof ladder?.dte === "number" && ladder.dte <= 10);
  const noWeeklies = !!ladder && !chainHasWeeklies;
  const empty = !ladder || !data.length;

  return (
    <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 10, marginBottom: 12 }}>
      {/* Header — magnet callout keeps target strike centered and readable */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 8, alignItems: "center", marginBottom: 8, justifyContent: "space-between" }}>
        <div style={{ fontSize: 10, color: "#d2a8ff", letterSpacing: 1.5, fontWeight: 700 }}>
          ⚡ OPTIONS FLOW MAGNET · {symbol}
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center", fontFamily: mono, fontSize: 10 }}>
          <div style={{ display: "flex", border: "1px solid #30363d", borderRadius: 4, overflow: "hidden" }}>
            {([["cum", "WEEK+"], ["day", "TODAY"]] as const).map(([m, label]) => (
              <button
                key={m}
                type="button"
                onClick={() => setMode(m)}
                style={{
                  padding: "2px 7px", border: "none", cursor: "pointer", fontFamily: mono, fontSize: 10, fontWeight: 700,
                  background: mode === m ? "#d2a8ff" : "#161b22",
                  color: mode === m ? "#0d1117" : "#8b949e",
                }}
              >
                {label}
              </button>
            ))}
          </div>
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
              {ladder.alternateExpiries.map((e, i) => {
                const v = typeof e.volume === "number" ? e.volume : null;
                const volLabel = v == null ? "" : v >= 1000 ? ` · ${(v / 1000).toFixed(1)}k` : ` · ${v}`;
                return (
                  <option key={e.expiry} value={i}>
                    EXP {e.label}{e.dte != null ? ` · ${e.dte}D` : ""}{volLabel}
                  </option>
                );
              })}
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

      {/* Live accumulation readout — proves the ladder is polling and growing */}
      {updatedAt != null && (
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", fontFamily: mono, fontSize: 9, color: "#6e7681", padding: "0 2px 6px" }}>
          <span style={{ color: "#39d353" }}>● LIVE</span>
          <span>updated {Math.max(0, Math.round((now.getTime() - updatedAt) / 1000))}s ago</span>
          {(deltaCall > 0 || deltaPut > 0) && (
            <span>
              added this poll:{" "}
              <span style={{ color: "#39d353", fontWeight: 700 }}>+{fmtVol(deltaCall)}C</span>{" · "}
              <span style={{ color: "#f85149", fontWeight: 700 }}>+{fmtVol(deltaPut)}P</span>
            </span>
          )}
          <span>· {mode === "cum" ? "cumulative open interest (all prior days + today)" : "today's session volume only"}</span>
        </div>
      )}

      {/* Estimated buy vs sell pressure — Lee-Ready on the chain snapshot */}
      {flowSide && (
        <div style={{ display: "flex", flexWrap: "wrap", gap: 10, alignItems: "center", fontFamily: mono, fontSize: 9, color: "#8b949e", padding: "0 2px 8px" }}>
          <span style={{ letterSpacing: 1, color: "#6e7681" }}>EST. AGGRESSOR</span>
          <span>
            CALLS <span style={{ color: "#39d353", fontWeight: 700 }}>{(flowSide.callBuyPct * 100).toFixed(0)}% BOUGHT</span>
            {" / "}
            <span style={{ color: "#f0883e", fontWeight: 700 }}>{(100 - flowSide.callBuyPct * 100).toFixed(0)}% SOLD</span>
          </span>
          <span>
            PUTS <span style={{ color: "#f85149", fontWeight: 700 }}>{(flowSide.putBuyPct * 100).toFixed(0)}% BOUGHT</span>
            {" / "}
            <span style={{ color: "#f0883e", fontWeight: 700 }}>{(100 - flowSide.putBuyPct * 100).toFixed(0)}% SOLD</span>
          </span>
          <span style={{ color: "#6e7681" }}>· est. from trade price vs bid/ask</span>
        </div>
      )}

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
              {fmtVol(magnet.volume)} {mode === "cum" ? "open contracts" : "contracts"} · {(magnet.pct * 100).toFixed(1)}% of {magnet.side.toLowerCase()} {mode === "cum" ? "OI" : "flow"}
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
            <span>◀ PUT {mode === "cum" ? "OI" : "FLOW"} · {fmtVol(totals.put)}</span>
            <span style={{ color: "#c9d1d9" }}>STRIKE</span>
            <span>CALL {mode === "cum" ? "OI" : "FLOW"} · {fmtVol(totals.call)} ▶</span>
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
            {mode === "cum"
              ? "Cumulative open interest — contracts still held from prior days/weeks plus today · magnet strike = heaviest OI concentration"
              : "Today's session option volume · magnet strike = heaviest volume concentration"}
          </div>
        </>
      )}
    </div>
  );
}