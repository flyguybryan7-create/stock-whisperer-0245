import { createFileRoute, Link, useSearch } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import { getIntraday, type IntradayBar } from "@/lib/quotes.functions";
import VelezChartPanel, { type Candle } from "@/components/VelezOpenIndicators";

export const Route = createFileRoute("/charts")({
  validateSearch: (s: Record<string, unknown>) => ({
    symbol: typeof s.symbol === "string" ? s.symbol.toUpperCase() : undefined,
    interval: (typeof s.interval === "string" ? s.interval : "2m") as "1m" | "2m" | "5m" | "15m",
    range: (typeof s.range === "string" ? s.range : "1d") as "1d" | "5d",
  }),
  head: () => ({
    meta: [
      { title: "OV Chart · BryanTrade" },
      { name: "description", content: "Oliver Velez first-20-minute opening-range chart with SMA bias, CCI(5), and Elephant Bar detection." },
      { property: "og:title", content: "OV Chart · BryanTrade" },
      { property: "og:description", content: "First-20-minute opening-range workflow on a 2-minute candle feed." },
    ],
  }),
  component: ChartsPage,
});

const FALLBACK = ["NVDA", "TSLA", "AAPL", "MRVL", "AMD", "PLTR", "SMCI", "MU", "ARM", "INTC"];
const WATCHLIST_KEY = "bryantrade.watchlist.v1";

function useWatchlistSymbols(): string[] {
  const [list, setList] = useState<string[]>(FALLBACK);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { symbols?: string[] };
        if (parsed.symbols?.length) setList(parsed.symbols);
      }
    } catch { /* ignore */ }
  }, []);
  return list;
}

function ChartsPage() {
  const search = useSearch({ from: "/charts" });
  const watchlist = useWatchlistSymbols();
  const [symbol, setSymbol] = useState(search.symbol ?? watchlist[0] ?? "NVDA");
  const [interval, setIntervalState] = useState<"1m" | "2m" | "5m" | "15m">(search.interval ?? "2m");
  const [range, setRange] = useState<"1d" | "5d">(search.range ?? "1d");
  const [input, setInput] = useState("");
  useEffect(() => { if (search.symbol) setSymbol(search.symbol); }, [search.symbol]);
  const fetchIntraday = useServerFn(getIntraday);
  const { data, isLoading } = useQuery({
    queryKey: ["ov-chart", symbol, interval, range],
    queryFn: () => fetchIntraday({ data: { symbol, interval, range } }),
    refetchInterval: 15_000,
    enabled: !!symbol,
  });
  const bars: IntradayBar[] = data ?? [];
  const candles: Candle[] = bars.map((b) => ({
    time: b.t * 1000, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume,
  }));

  return (
    <div style={{ minHeight: "100vh", background: "#010409", color: "#e6edf3", padding: "16px", fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12, flexWrap: "wrap", gap: 8 }}>
        <div>
          <Link to="/" style={{ color: "#58a6ff", fontSize: 13, fontWeight: 700, textDecoration: "none", padding: "8px 4px", display: "inline-block" }}>← WATCHLIST</Link>
          <span style={{ marginLeft: 12, fontSize: 16, fontWeight: 800, letterSpacing: 1.5 }}>OV CHART</span>
        </div>
        <form
          onSubmit={(e) => { e.preventDefault(); const s = input.trim().toUpperCase(); if (s) { setSymbol(s); setInput(""); } }}
          style={{ display: "flex", gap: 6 }}>
          <input value={input} onChange={(e) => setInput(e.target.value)} placeholder="Symbol…"
            style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 4, padding: "4px 8px", color: "#e6edf3", fontSize: 12, width: 100, fontFamily: "inherit" }} />
          <button type="submit" style={{ background: "#238636", border: "none", borderRadius: 4, color: "#fff", padding: "4px 10px", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>LOAD</button>
        </form>
      </div>
      {/* Timeframe selector */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 9, color: "#8b949e", marginRight: 4 }}>RANGE</span>
        {(["1d","5d"] as const).map((r) => (
          <button key={r} onClick={() => setRange(r)}
            style={{ background: r === range ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "3px 8px", fontSize: 11,
              color: r === range ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: "inherit" }}>{r.toUpperCase()}</button>
        ))}
        <span style={{ fontSize: 9, color: "#8b949e", margin: "0 4px 0 12px" }}>INTERVAL</span>
        {(["1m","2m","5m","15m"] as const).map((iv) => (
          <button key={iv} onClick={() => setIntervalState(iv)}
            style={{ background: iv === interval ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "3px 8px", fontSize: 11,
              color: iv === interval ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: "inherit" }}>{iv}</button>
        ))}
      </div>
      {/* Full watchlist symbol selector */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginBottom: 12, maxHeight: 120, overflowY: "auto" }}>
        {watchlist.map((s) => (
          <button key={s} onClick={() => setSymbol(s)}
            style={{
              background: s === symbol ? "#21262d" : "transparent",
              border: "1px solid #21262d", borderRadius: 4, padding: "3px 8px", fontSize: 11,
              color: s === symbol ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: "inherit",
            }}>{s}</button>
        ))}
      </div>
      {isLoading && candles.length === 0
        ? <div style={{ textAlign: "center", padding: 40, color: "#8b949e" }}>Loading {symbol}…</div>
        : <VelezChartPanel candles={candles} ticker={symbol} />}
    </div>
  );
}