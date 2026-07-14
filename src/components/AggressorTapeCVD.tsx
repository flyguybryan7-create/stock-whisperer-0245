import { useEffect, useMemo, useRef, useState } from "react";
import { useServerFn } from "@tanstack/react-start";
import {
  ComposedChart, Line, Scatter, XAxis, YAxis, CartesianGrid, ReferenceLine,
  ResponsiveContainer, Tooltip,
} from "recharts";
import { getSchwabQuotes, refreshSchwabToken, type SchwabTokens } from "@/lib/schwab.functions";

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

export function AggressorTapeCVD({ symbol, tokens, onTokens }: Props) {
  const fetchQuotes = useServerFn(getSchwabQuotes);
  const refresh = useServerFn(refreshSchwabToken);
  const [prints, setPrints] = useState<Print[]>([]);
  const [status, setStatus] = useState<string>("idle");
  const lastVolRef = useRef<number | null>(null);
  const lastPriceRef = useRef<number | null>(null);
  const cvdRef = useRef<number>(0);
  const symbolRef = useRef(symbol);

  // Reset the tape when the user switches tickers so buy/sell/CVD reflect
  // only the currently displayed symbol.
  useEffect(() => {
    if (symbolRef.current !== symbol) {
      symbolRef.current = symbol;
      setPrints([]);
      cvdRef.current = 0;
      lastVolRef.current = null;
      lastPriceRef.current = null;
    }
  }, [symbol]);

  useEffect(() => {
    if (!tokens?.access_token || !symbol) return;
    let cancelled = false;

    async function tick() {
      if (cancelled) return;
      try {
        let token = tokens!.access_token;
        let quotes;
        try {
          quotes = await fetchQuotes({ data: { accessToken: token, symbols: [symbol] } });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          if (msg.includes("schwab_unauthorized") && tokens!.refresh_token) {
            const fresh = await refresh({ data: { refreshToken: tokens!.refresh_token } });
            onTokens(fresh);
            token = fresh.access_token;
            quotes = await fetchQuotes({ data: { accessToken: token, symbols: [symbol] } });
          } else {
            throw e;
          }
        }
        const q = quotes[symbol];
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
  }, [tokens, symbol, fetchQuotes, refresh, onTokens]);

  const chartData = useMemo(() => prints.map((p) => ({
    t: p.t,
    price: p.price,
    cvd: p.cvd,
    buySize: p.side === "BUY" ? p.size : null,
    sellSize: p.side === "SELL" ? p.size : null,
  })), [prints]);

  const totals = useMemo(() => {
    let buy = 0, sell = 0, mid = 0;
    for (const p of prints) {
      if (p.side === "BUY") buy += p.size;
      else if (p.side === "SELL") sell += p.size;
      else mid += p.size;
    }
    return { buy, sell, mid, cvd: cvdRef.current, delta: buy - sell };
  }, [prints]);

  const imbalancePct = totals.buy + totals.sell > 0
    ? (totals.buy - totals.sell) / (totals.buy + totals.sell)
    : 0;

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

  if (!tokens?.access_token) {
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

      {chartData.length < 2 ? (
        <div style={{ padding: 20, textAlign: "center", fontSize: 10, color: "#6e7681" }}>
          Waiting for trades… (needs at least 2 quote polls to compute the first print)
        </div>
      ) : (
        <>
          {/* Top pane: price line + colored buy/sell prints sized by trade volume */}
          <div style={{ fontSize: 9, color: "#8b949e", fontFamily: mono, padding: "0 4px 2px" }}>PRICE · aggressor prints</div>
          <ResponsiveContainer width="100%" height={180}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={fmtTime}
                stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
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
                shape="circle" isAnimationActive={false} />
              <Scatter yAxisId="p" dataKey="price" data={chartData.filter((d) => d.sellSize)} fill="#f85149"
                shape="circle" isAnimationActive={false} />
            </ComposedChart>
          </ResponsiveContainer>

          {/* Bottom pane: Cumulative Volume Delta line — where flow is pushing */}
          <div style={{ fontSize: 9, color: "#8b949e", fontFamily: mono, padding: "4px 4px 2px" }}>CUMULATIVE VOLUME DELTA</div>
          <ResponsiveContainer width="100%" height={110}>
            <ComposedChart data={chartData} margin={{ top: 4, right: 12, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
              <XAxis dataKey="t" type="number" domain={["dataMin", "dataMax"]} tickFormatter={fmtTime}
                stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
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
            Lee–Ready tick rule · CVD divergence vs price = absorption / exhaustion signal · polls every 2s
          </div>
        </>
      )}
    </div>
  );
}