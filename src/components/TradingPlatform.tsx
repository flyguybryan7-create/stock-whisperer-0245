import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getQuotes, searchSymbols, getLiveQuotes, getNews, analyzeNewsSentiment,
  type Candle, type SymbolSearchResult, type LiveQuote, type NewsItem, type SentimentResult,
} from "@/lib/quotes.functions";
import { sendSmsAlert } from "@/lib/alerts.functions";
import { getSchwabAuthUrl } from "@/lib/schwab.functions";
import { getShortInterest, type ShortInterest } from "@/lib/shortinterest.functions";
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, AreaChart, Area, ComposedChart, Bar, BarChart, Cell,
} from "recharts";

const DEFAULT_STOCKS = [
  "NVDA","MRVL","SMTC","TSEM","INTC","QBTS","INFQ","HUT","CRDO","ALAB","SNOW","NVTS","MCHP","ANET",
  "MU","AMD","PLTR","GOOG","APLD","ARM","TSM","OKLO","NTAP","AMZN","GSAT","NXPI","ORCL","SMCI",
  "CRWV","CBRS","RMBS","LSCC","MXL","AMBA","PLAB","ASYS","COHU","NLST","ACLS","STM","SATS","WDC",
];
const WATCHLIST_KEY = "bryantrade.watchlist.v1";
const SMS_PHONE = "9549391199";
const SMS_CARRIER = "tmobile";
const SMS_ENABLED_KEY = "bryantrade.smsAlerts.v1";
const SCHWAB_TOKEN_KEY = "bryantrade.schwab.tokens.v1";

const STOCK_NAMES: Record<string, string> = {
  NVDA:"NVIDIA Corp",MRVL:"Marvell Technology",SMTC:"Semtech Corp",TSEM:"Tower Semiconductor",
  INTC:"Intel Corp",QBTS:"D-Wave Quantum",INFQ:"Infleqtion Inc",HUT:"Hut 8 Corp",
  CRDO:"Credo Technology",ALAB:"Astera Labs",SNOW:"Snowflake Inc",NVTS:"Navitas Semi",
  MCHP:"Microchip Tech",ANET:"Arista Networks",MU:"Micron Technology",AMD:"Advanced Micro",
  PLTR:"Palantir Tech",GOOG:"Alphabet Inc",APLD:"Applied Digital",ARM:"ARM Holdings",
  TSM:"Taiwan Semi",OKLO:"Oklo Inc",NTAP:"NetApp Inc",AMZN:"Amazon.com",
  GSAT:"Globalstar Inc",NXPI:"NXP Semiconductors",ORCL:"Oracle Corp",SMCI:"Super Micro",
  CRWV:"CoreWeave Inc",CBRS:"Cerebras Systems",RMBS:"Rambus Inc",LSCC:"Lattice Semi",
  MXL:"MaxLinear Inc",AMBA:"Ambarella Inc",PLAB:"Photronics Inc",ASYS:"Amtech Systems",
  COHU:"Cohu Inc",NLST:"Netlist Inc",ACLS:"Axcelis Tech",STM:"STMicroelectronics",
  SATS:"EchoStar Corp",WDC:"Western Digital",
};

type Row = {
  date: string; close: number; open: number; high: number; low: number; volume: number;
  sma9?: number | null; sma15?: number | null; sma50?: number | null; ema9?: number | null;
  rsi?: number | null; bbUpper?: number | null; bbMiddle?: number | null; bbLower?: number | null;
  macd?: number | null; macdSignal?: number | null; macdHist?: number | null;
};

function calcSMA(data: Row[], period: number, key: "sma9"|"sma15"|"sma50") {
  return data.map((d, i) => {
    if (i < period - 1) return { ...d, [key]: null };
    const slice = data.slice(i - period + 1, i + 1);
    const avg = slice.reduce((s, x) => s + x.close, 0) / period;
    return { ...d, [key]: +avg.toFixed(2) };
  });
}
function calcEMA(data: Row[], period: number, key: "ema9") {
  const k = 2 / (period + 1);
  let ema = data[0].close;
  return data.map((d, i) => {
    if (i === 0) { ema = d.close; return { ...d, [key]: ema }; }
    ema = d.close * k + ema * (1 - k);
    return { ...d, [key]: +ema.toFixed(2) };
  });
}
function calcRSI(data: Row[], period = 14) {
  const changes = data.map((d, i) => i === 0 ? 0 : d.close - data[i - 1].close);
  return data.map((d, i) => {
    if (i < period) return { ...d, rsi: null };
    const slice = changes.slice(i - period + 1, i + 1);
    const gains = slice.filter(c => c > 0).reduce((s, c) => s + c, 0) / period;
    const losses = slice.filter(c => c < 0).reduce((s, c) => s + Math.abs(c), 0) / period;
    const rs = losses === 0 ? 100 : gains / losses;
    return { ...d, rsi: +(100 - 100 / (1 + rs)).toFixed(2) };
  });
}
function calcBollinger(data: Row[], period = 20, mult = 2) {
  return data.map((d, i) => {
    if (i < period - 1) return { ...d, bbUpper: null, bbMiddle: null, bbLower: null };
    const slice = data.slice(i - period + 1, i + 1);
    const mean = slice.reduce((s, x) => s + x.close, 0) / period;
    const variance = slice.reduce((s, x) => s + Math.pow(x.close - mean, 2), 0) / period;
    const std = Math.sqrt(variance);
    return { ...d, bbUpper: +(mean + mult * std).toFixed(2), bbMiddle: +mean.toFixed(2), bbLower: +(mean - mult * std).toFixed(2) };
  });
}
function calcMACD(data: Row[], fast = 12, slow = 26, signal = 9) {
  const kF = 2 / (fast + 1), kS = 2 / (slow + 1), kSig = 2 / (signal + 1);
  let emaFast = data[0].close, emaSlow = data[0].close, emaSignal = 0;
  return data.map((d, i) => {
    emaFast = i === 0 ? d.close : d.close * kF + emaFast * (1 - kF);
    emaSlow = i === 0 ? d.close : d.close * kS + emaSlow * (1 - kS);
    const macd = emaFast - emaSlow;
    if (i === 0) emaSignal = macd; else emaSignal = macd * kSig + emaSignal * (1 - kSig);
    return { ...d, macd: +macd.toFixed(4), macdSignal: +emaSignal.toFixed(4), macdHist: +(macd - emaSignal).toFixed(4) };
  });
}

function buildChartData(p: Row[]) {
  let d = calcSMA(p, 9, "sma9");
  d = calcSMA(d, 15, "sma15");
  d = calcSMA(d, 50, "sma50");
  d = calcEMA(d, 9, "ema9");
  d = calcRSI(d);
  d = calcBollinger(d);
  d = calcMACD(d);
  return d;
}

function getSignal(data: Row[], sentimentScore = 0): "BUY" | "SELL" | "HOLD" {
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  if (!last || !prev) return "HOLD";
  let bull = 0, bear = 0;
  if ((last.rsi ?? 50) < 30) bull += 2;
  if ((last.rsi ?? 50) > 70) bear += 2;
  if ((last.macdHist ?? 0) > 0 && (prev.macdHist ?? 0) < 0) bull += 2;
  if ((last.macdHist ?? 0) < 0 && (prev.macdHist ?? 0) > 0) bear += 2;
  if (last.sma9 && last.sma15 && last.close > last.sma9 && last.sma9 > last.sma15) bull++;
  if (last.sma9 && last.sma15 && last.close < last.sma9 && last.sma9 < last.sma15) bear++;
  if (last.bbLower && last.close <= last.bbLower) bull += 2;
  if (last.bbUpper && last.close >= last.bbUpper) bear += 2;
  // News sentiment overlay (-1..+1) — adds up to ±3 weight
  if (sentimentScore > 0.15) bull += Math.round(sentimentScore * 3);
  if (sentimentScore < -0.15) bear += Math.round(-sentimentScore * 3);
  if (bull > bear + 1) return "BUY";
  if (bear > bull + 1) return "SELL";
  return "HOLD";
}

const CustomTooltip = ({ active, payload, label }: any) => {
  if (active && payload && payload.length) {
    return (
      <div style={{ background: "#0d1117", border: "1px solid #30363d", padding: 8, borderRadius: 6, fontSize: 11, fontFamily: "JetBrains Mono, monospace" }}>
        <div style={{ color: "#8b949e", marginBottom: 4 }}>{label}</div>
        {payload.map((p: any, i: number) => (
          <div key={i} style={{ color: p.color || p.stroke || "#e6edf3" }}>
            {p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : p.value}
          </div>
        ))}
      </div>
    );
  }
  return null;
};

type Alert = { price: number; type: "above" | "below"; phone: string; active: boolean };

export default function TradingPlatform() {
  const [watchlist, setWatchlist] = useState<string[]>(DEFAULT_STOCKS);
  const [stockNames, setStockNames] = useState<Record<string, string>>(STOCK_NAMES);
  const [selectedStock, setSelectedStock] = useState("MRVL");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [alerts, setAlerts] = useState<Record<string, Alert[]>>({});
  const [phoneNumber, setPhoneNumber] = useState("");
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertPrice, setAlertPrice] = useState("");
  const [alertType, setAlertType] = useState<"above" | "below">("above");
  const [notification, setNotification] = useState<{ msg: string } | null>(null);
  const [chartRange, setChartRange] = useState(60);
  const [smsEnabled, setSmsEnabled] = useState(true);
  const lastSmsSignal = useRef<Record<string, "BUY" | "SELL">>({});

  // Load persisted watchlist
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { symbols?: string[]; names?: Record<string, string> };
        if (parsed.symbols?.length) setWatchlist(parsed.symbols);
        if (parsed.names) setStockNames((s) => ({ ...s, ...parsed.names }));
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify({ symbols: watchlist, names: stockNames }));
    } catch {}
  }, [watchlist, stockNames]);

  const fetchQuotes = useServerFn(getQuotes);
  const fetchSearch = useServerFn(searchSymbols);
  const fetchLive = useServerFn(getLiveQuotes);
  const fetchNews = useServerFn(getNews);
  const fetchSentiment = useServerFn(analyzeNewsSentiment);
  const fireSms = useServerFn(sendSmsAlert);
  const fetchShort = useServerFn(getShortInterest);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SMS_ENABLED_KEY);
      if (raw != null) setSmsEnabled(raw === "1");
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(SMS_ENABLED_KEY, smsEnabled ? "1" : "0"); } catch {}
  }, [smsEnabled]);

  const { data: rawQuotes } = useQuery({
    queryKey: ["quotes", watchlist],
    queryFn: () => fetchQuotes({ data: { symbols: watchlist } }),
    staleTime: 60_000,
    refetchInterval: 60_000,
  });

  // Live intraday prices — refresh every 1s
  const { data: liveQuotes } = useQuery({
    queryKey: ["live", watchlist],
    queryFn: () => fetchLive({ data: { symbols: watchlist } }),
    refetchInterval: 1000,
    enabled: watchlist.length > 0,
  });
  const live = (liveQuotes as Record<string, LiveQuote> | undefined) ?? {};

  // Short interest / float — refresh every 30 min (Yahoo updates twice a month)
  const { data: shortData } = useQuery({
    queryKey: ["short", watchlist],
    queryFn: () => fetchShort({ data: { symbols: watchlist } }),
    staleTime: 30 * 60_000,
    refetchInterval: 30 * 60_000,
    enabled: watchlist.length > 0,
  });
  const shorts = (shortData as Record<string, ShortInterest> | undefined) ?? {};

  // News for selected stock
  const { data: newsData } = useQuery({
    queryKey: ["news", selectedStock, stockNames[selectedStock] || ""],
    queryFn: () => fetchNews({ data: { symbol: selectedStock, companyName: stockNames[selectedStock] } }),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    enabled: !!selectedStock,
  });
  const newsItems: NewsItem[] = newsData?.items ?? [];
  const sector = newsData?.sector ?? null;

  // AI sentiment based on headlines
  const { data: sentimentData } = useQuery({
    queryKey: ["sentiment", selectedStock, newsItems.map((n) => n.title).join("|")],
    queryFn: () => fetchSentiment({
      data: {
        symbol: selectedStock,
        headlines: newsItems.map((n) => ({ title: n.title, scope: n.scope })),
      },
    }),
    enabled: newsItems.length > 0,
    staleTime: 5 * 60_000,
  });
  const sentiment: SentimentResult = sentimentData ?? { score: 0, label: "NEUTRAL", summary: "", drivers: [] };

  // Debounced symbol search
  const [debouncedQuery, setDebouncedQuery] = useState("");
  useEffect(() => {
    const id = setTimeout(() => setDebouncedQuery(search.trim()), 250);
    return () => clearTimeout(id);
  }, [search]);
  const { data: searchResults = [], isFetching: searching } = useQuery({
    queryKey: ["symbolSearch", debouncedQuery],
    queryFn: () => fetchSearch({ data: { query: debouncedQuery } }),
    enabled: debouncedQuery.length >= 1,
    staleTime: 30_000,
  });

  const allData: Record<string, Row[]> = {};
  if (rawQuotes) {
    for (const sym of watchlist) {
      const candles = (rawQuotes as Record<string, Candle[]>)[sym] || [];
      if (candles.length > 0) allData[sym] = buildChartData(candles as Row[]);
    }
  }

  // Overlay live price into the last bar of each series so the chart "tickles"
  for (const sym of Object.keys(allData)) {
    const lq = live[sym];
    const series = allData[sym];
    if (lq && series.length > 0) {
      const lastBar = { ...series[series.length - 1] };
      lastBar.close = lq.price;
      if (lq.price > lastBar.high) lastBar.high = lq.price;
      if (lq.price < lastBar.low) lastBar.low = lq.price;
      series[series.length - 1] = lastBar;
      allData[sym] = buildChartData(series);
    }
  }

  const chartData = allData[selectedStock] || [];
  const displayData = chartData.slice(-chartRange);
  const last = chartData[chartData.length - 1] || ({} as Row);
  const prev = chartData[chartData.length - 2] || ({} as Row);
  const liveSel = live[selectedStock];
  const change = liveSel ? liveSel.change : (last.close && prev.close ? last.close - prev.close : 0);
  const changePct = liveSel ? liveSel.changePercent : (prev.close ? (change / prev.close) * 100 : 0);
  const signal = getSignal(chartData, sentiment.score);

  // Watch every watchlist symbol; when its signal flips to BUY or SELL,
  // fire an SMS via T-Mobile email-to-SMS gateway (server-side cooldown
  // prevents flooding even if state churns).
  useEffect(() => {
    if (!smsEnabled) return;
    for (const sym of Object.keys(allData)) {
      const series = allData[sym];
      if (!series || series.length === 0) continue;
      const sig = getSignal(series, sym === selectedStock ? sentiment.score : 0);
      if (sig !== "BUY" && sig !== "SELL") continue;
      if (lastSmsSignal.current[sym] === sig) continue;
      lastSmsSignal.current[sym] = sig;
      const lq = live[sym];
      const px = lq?.price ?? series[series.length - 1]?.close;
      if (px == null) continue;
      fireSms({
        data: {
          phone: SMS_PHONE,
          carrier: SMS_CARRIER,
          symbol: sym,
          signal: sig,
          price: px,
          reason: sym === selectedStock && sentiment.summary ? sentiment.summary.slice(0, 80) : "",
        },
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveQuotes, rawQuotes, smsEnabled, sentiment.score]);

  const filteredStocks = useMemo(() => {
    const q = search.toLowerCase();
    return watchlist.filter((s) =>
      s.toLowerCase().includes(q) || (stockNames[s] || "").toLowerCase().includes(q),
    );
  }, [watchlist, stockNames, search]);

  const newResults: SymbolSearchResult[] = (searchResults as SymbolSearchResult[]).filter(
    (r) => !watchlist.includes(r.symbol.toUpperCase()),
  );

  const addStock = (r: SymbolSearchResult) => {
    const sym = r.symbol.toUpperCase();
    setWatchlist((prev) => (prev.includes(sym) ? prev : [sym, ...prev]));
    setStockNames((prev) => ({ ...prev, [sym]: r.name }));
    setSelectedStock(sym);
    setSearch("");
    setSearchFocused(false);
    showNotif(`Added ${sym} to watchlist`);
  };

  const removeStock = (sym: string) => {
    setWatchlist((prev) => {
      const next = prev.filter((s) => s !== sym);
      if (selectedStock === sym && next.length) setSelectedStock(next[0]);
      return next;
    });
  };

  // Drag-and-drop reorder
  const dragSym = useRef<string | null>(null);
  const onDragStart = (sym: string) => { dragSym.current = sym; };
  const onDragOver = (e: React.DragEvent) => { e.preventDefault(); };
  const onDrop = (target: string) => {
    const src = dragSym.current;
    dragSym.current = null;
    if (!src || src === target) return;
    setWatchlist((prev) => {
      const next = prev.filter((s) => s !== src);
      const idx = next.indexOf(target);
      if (idx < 0) return prev;
      next.splice(idx, 0, src);
      return next;
    });
  };

  const showNotif = (msg: string) => {
    setNotification({ msg });
    setTimeout(() => setNotification(null), 3000);
  };

  const addAlert = () => {
    if (!alertPrice) return;
    const newAlert: Alert = { price: parseFloat(alertPrice), type: alertType, phone: phoneNumber, active: true };
    setAlerts(prev => ({ ...prev, [selectedStock]: [...(prev[selectedStock] || []), newAlert] }));
    setShowAlertModal(false);
    setAlertPrice("");
    showNotif(`Alert set for ${selectedStock} ${alertType} $${alertPrice}${phoneNumber ? ` → SMS to ${phoneNumber}` : ""}`);
  };

  const signalColor = signal === "BUY" ? "#39d353" : signal === "SELL" ? "#f85149" : "#e3b341";
  const signalBg = signal === "BUY" ? "rgba(57,211,83,0.1)" : signal === "SELL" ? "rgba(248,81,73,0.1)" : "rgba(227,179,65,0.1)";

  const mono = "JetBrains Mono, ui-monospace, monospace";

  return (
    <div style={{ minHeight: "100vh", background: "#010409", color: "#e6edf3", fontFamily: mono, fontSize: 12 }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Orbitron:wght@700;900&display=swap');
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #010409; }
        ::-webkit-scrollbar-thumb { background: #21262d; border-radius: 2px; }
        * { box-sizing: border-box; }
        .stock-row:hover { background: #161b22 !important; cursor: pointer; }
        .btn-primary:hover { filter: brightness(1.2); }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        @keyframes slideIn { from { transform: translateY(-20px); opacity:0; } to { transform: translateY(0); opacity:1; } }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #21262d", background: "#0d1117" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 16, color: "#58a6ff", letterSpacing: 1 }}>⬡ BRYANTRADE</div>
          <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 2 }}>PRO TERMINAL</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#39d353" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#39d353", animation: "pulse 2s infinite" }} />
            LIVE
          </div>
          <button onClick={() => setShowAlertModal(true)} className="btn-primary"
            style={{ background: "#21262d", border: "1px solid #30363d", color: "#e6edf3", padding: "6px 12px", borderRadius: 6, fontSize: 11, cursor: "pointer", display: "flex", alignItems: "center", gap: 6 }}>
            🔔 Set Alert
          </button>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "240px 1fr", minHeight: "calc(100vh - 49px)" }}>
        {/* Watchlist */}
        <div style={{ borderRight: "1px solid #21262d", background: "#0d1117", overflowY: "auto", maxHeight: "calc(100vh - 49px)" }}>
          <div style={{ padding: "10px 12px", borderBottom: "1px solid #21262d", position: "relative" }}>
            <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 1.5, marginBottom: 8 }}>BRYAN'S WATCHLIST</div>
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              onFocus={() => setSearchFocused(true)}
              onBlur={() => setTimeout(() => setSearchFocused(false), 150)}
              placeholder="Search any ticker (AAPL, TSLA…)"
              style={{ width: "100%", background: "#010409", border: "1px solid #21262d", borderRadius: 5, padding: "5px 8px", color: "#e6edf3", fontSize: 11, outline: "none", fontFamily: mono }}
            />
            {searchFocused && debouncedQuery.length >= 1 && (
              <div style={{ position: "absolute", top: "100%", left: 12, right: 12, background: "#0d1117", border: "1px solid #30363d", borderRadius: 6, marginTop: 4, zIndex: 50, maxHeight: 280, overflowY: "auto", boxShadow: "0 8px 24px rgba(0,0,0,0.6)" }}>
                {searching && newResults.length === 0 && (
                  <div style={{ padding: "8px 10px", fontSize: 10, color: "#8b949e" }}>Searching…</div>
                )}
                {!searching && newResults.length === 0 && (
                  <div style={{ padding: "8px 10px", fontSize: 10, color: "#8b949e" }}>No new symbols found</div>
                )}
                {newResults.map((r) => (
                  <div
                    key={r.symbol}
                    onMouseDown={(e) => { e.preventDefault(); addStock(r); }}
                    style={{ padding: "8px 10px", borderBottom: "1px solid #161b22", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 }}
                    className="stock-row"
                  >
                    <div style={{ minWidth: 0 }}>
                      <div style={{ fontSize: 11, fontWeight: 700, color: "#e6edf3" }}>{r.symbol}</div>
                      <div style={{ fontSize: 9, color: "#8b949e", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {r.name}{r.exchange ? ` · ${r.exchange}` : ""}
                      </div>
                    </div>
                    <span style={{ fontSize: 14, color: "#39d353" }}>+</span>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            {filteredStocks.map(sym => {
              const d = allData[sym] || [];
              const l = d[d.length - 1]; const p = d[d.length - 2];
              const chg = l && p ? ((l.close - p.close) / p.close) * 100 : 0;
              const sig = d.length ? getSignal(d) : "HOLD";
              const hasAlert = (alerts[sym]?.length ?? 0) > 0;
              const sigC = sig === "BUY" ? "#39d353" : sig === "SELL" ? "#f85149" : "#e3b341";
              const lq = live[sym];
              const liveChg = lq ? lq.changePercent : chg;
              const livePrice = lq ? lq.price : l?.close;
              return (
                <div key={sym} className="stock-row" onClick={() => setSelectedStock(sym)}
                  draggable
                  onDragStart={() => onDragStart(sym)}
                  onDragOver={onDragOver}
                  onDrop={() => onDrop(sym)}
                  title="Drag to reorder"
                  style={{ padding: "8px 12px", borderBottom: "1px solid #161b22", background: selectedStock === sym ? "#161b22" : "transparent", borderLeft: selectedStock === sym ? "2px solid #58a6ff" : "2px solid transparent" }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontWeight: 600, fontSize: 12, display: "flex", alignItems: "center", gap: 4 }}>
                      <span style={{ color: "#484f58", cursor: "grab", marginRight: 2 }}>⋮⋮</span>
                      {sym}
                      {hasAlert && <span style={{ fontSize: 9 }}>🔔</span>}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                      <span style={{ fontSize: 9, color: sigC, fontWeight: 700 }}>{sig}</span>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeStock(sym); }}
                        title="Remove from watchlist"
                        style={{ background: "transparent", border: "none", color: "#8b949e", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}
                      >✕</button>
                    </div>
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 2, fontSize: 10 }}>
                    <span style={{ color: "#8b949e" }}>${livePrice?.toFixed(2)}</span>
                    <span style={{ color: liveChg >= 0 ? "#39d353" : "#f85149" }}>{liveChg >= 0 ? "+" : ""}{liveChg.toFixed(2)}%</span>
                  </div>
                </div>
              );
            })}
            {watchlist.length === 0 && (
              <div style={{ padding: 16, fontSize: 10, color: "#8b949e", textAlign: "center" }}>
                Your watchlist is empty. Search above to add stocks.
              </div>
            )}
          </div>
        </div>

        {/* Main */}
        <div style={{ padding: 16, overflowY: "auto", maxHeight: "calc(100vh - 49px)" }}>
          {/* Stock header */}
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 16, marginBottom: 14 }}>
            <div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10 }}>
                <span style={{ fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 22, color: "#e6edf3" }}>{selectedStock}</span>
                <span style={{ fontSize: 11, color: "#8b949e" }}>{stockNames[selectedStock] || ""}</span>
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
                <span style={{ fontSize: 28, fontWeight: 700, color: "#e6edf3" }}>${(liveSel?.price ?? last.close)?.toFixed(2)}</span>
                <span style={{ fontSize: 13, fontWeight: 600, color: change >= 0 ? "#39d353" : "#f85149" }}>
                  {change >= 0 ? "▲" : "▼"} ${Math.abs(change).toFixed(2)} ({changePct >= 0 ? "+" : ""}{changePct.toFixed(2)}%)
                </span>
                {liveSel && (() => {
                  const s = liveSel.session;
                  const label = s === "PRE" ? "PRE-MARKET" : s === "POST" ? "AFTER-HOURS" : s === "REGULAR" ? "LIVE" : "CLOSED";
                  const color = s === "REGULAR" ? "#39d353" : s === "PRE" ? "#58a6ff" : s === "POST" ? "#d2a8ff" : "#8b949e";
                  return (
                    <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: 1, color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 6px" }}>
                      ● {label}
                    </span>
                  );
                })()}
              </div>
              {liveSel && (liveSel.preMarketPrice || liveSel.postMarketPrice) && (
                <div style={{ display: "flex", gap: 12, marginTop: 6, fontSize: 10, color: "#8b949e" }}>
                  {typeof liveSel.regularPrice === "number" && (
                    <span>Reg <span style={{ color: "#e6edf3" }}>${liveSel.regularPrice.toFixed(2)}</span></span>
                  )}
                  {typeof liveSel.preMarketPrice === "number" && (
                    <span>Pre <span style={{ color: (liveSel.preMarketChangePercent ?? 0) >= 0 ? "#39d353" : "#f85149" }}>${liveSel.preMarketPrice.toFixed(2)} ({(liveSel.preMarketChangePercent ?? 0) >= 0 ? "+" : ""}{(liveSel.preMarketChangePercent ?? 0).toFixed(2)}%)</span></span>
                  )}
                  {typeof liveSel.postMarketPrice === "number" && (
                    <span>After <span style={{ color: (liveSel.postMarketChangePercent ?? 0) >= 0 ? "#39d353" : "#f85149" }}>${liveSel.postMarketPrice.toFixed(2)} ({(liveSel.postMarketChangePercent ?? 0) >= 0 ? "+" : ""}{(liveSel.postMarketChangePercent ?? 0).toFixed(2)}%)</span></span>
                  )}
                </div>
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <SchwabConnectButton />
              <button
                onClick={() => { setSmsEnabled((v) => !v); showNotif(`SMS alerts ${!smsEnabled ? "ON" : "OFF"} → ${SMS_PHONE.replace(/(\d{3})(\d{3})(\d{4})/, "($1) $2-$3")}`); }}
                title={`Auto-text BUY/SELL to ${SMS_PHONE} (T-Mobile)`}
                style={{ background: smsEnabled ? "#1f3d2a" : "#0d1117", border: `1px solid ${smsEnabled ? "#39d353" : "#21262d"}`, borderRadius: 6, padding: "6px 10px", minWidth: 80, cursor: "pointer", color: smsEnabled ? "#39d353" : "#8b949e", fontFamily: "inherit" }}
              >
                <div style={{ fontSize: 9, letterSpacing: 1 }}>SMS ALERTS</div>
                <div style={{ fontSize: 13, fontWeight: 800 }}>{smsEnabled ? "📱 ON" : "OFF"}</div>
              </button>
              <div style={{ background: signalBg, border: `1px solid ${signalColor}`, borderRadius: 6, padding: "6px 12px", minWidth: 80 }}>
                <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>AI SIGNAL</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: signalColor }}>{signal}</div>
              </div>
              <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: "6px 12px", minWidth: 70 }}>
                <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>RSI</div>
                <div style={{ fontSize: 16, color: (last.rsi ?? 50) < 30 ? "#39d353" : (last.rsi ?? 50) > 70 ? "#f85149" : "#e6edf3", fontWeight: 600 }}>{last.rsi?.toFixed(1)}</div>
              </div>
              <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: "6px 12px", minWidth: 80 }}>
                <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>MACD</div>
                <div style={{ fontSize: 16, color: (last.macdHist ?? 0) > 0 ? "#39d353" : "#f85149", fontWeight: 600 }}>{last.macdHist?.toFixed(3)}</div>
              </div>
              <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 6, padding: "6px 12px", minWidth: 80 }}>
                <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>SMA9</div>
                <div style={{ fontSize: 16, color: "#79c0ff", fontWeight: 600 }}>${last.sma9?.toFixed(2)}</div>
              </div>
            </div>
          </div>

          {/* Range */}
          <div style={{ display: "flex", gap: 4, marginBottom: 8 }}>
            {[14, 30, 60, 90, 120].map(r => (
              <button key={r} onClick={() => setChartRange(r)}
                style={{ background: chartRange === r ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "4px 10px", fontSize: 10, color: chartRange === r ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: mono }}>
                {r}D
              </button>
            ))}
          </div>

          {/* Price chart */}
          <ChartCard title="PRICE · MOVING AVERAGES · BOLLINGER BANDS"
            legend={[{ label: "SMA9", color: "#79c0ff" }, { label: "SMA15", color: "#d2a8ff" }, { label: "SMA50", color: "#ffa657" }, { label: "BB Upper/Lower", color: "#30363d" }]}>
            <ResponsiveContainer width="100%" height={280}>
              <ComposedChart data={displayData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="date" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
                <YAxis stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} domain={["auto", "auto"]} tickFormatter={(v: number) => `$${v}`} width={55} />
                <Tooltip content={<CustomTooltip />} />
                <Area type="monotone" dataKey="bbUpper" stroke="#30363d" fill="#30363d" fillOpacity={0.1} name="BB Upper" />
                <Area type="monotone" dataKey="bbLower" stroke="#30363d" fill="#010409" fillOpacity={1} name="BB Lower" />
                <Line type="monotone" dataKey="close" stroke="#e6edf3" strokeWidth={2} dot={false} name="Close" />
                <Line type="monotone" dataKey="sma9" stroke="#79c0ff" strokeWidth={1} dot={false} name="SMA9" />
                <Line type="monotone" dataKey="sma15" stroke="#d2a8ff" strokeWidth={1} dot={false} name="SMA15" />
                <Line type="monotone" dataKey="sma50" stroke="#ffa657" strokeWidth={1} dot={false} name="SMA50" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* RSI */}
          <ChartCard title="RSI (14) — RELATIVE STRENGTH INDEX">
            <ResponsiveContainer width="100%" height={140}>
              <AreaChart data={displayData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="date" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
                <YAxis stroke="#8b949e" fontSize={9} domain={[0, 100]} ticks={[0, 30, 50, 70, 100]} width={35} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={70} stroke="#f85149" strokeDasharray="3 3" />
                <ReferenceLine y={30} stroke="#39d353" strokeDasharray="3 3" />
                <Area type="monotone" dataKey="rsi" stroke="#e3b341" fill="#e3b341" fillOpacity={0.15} strokeWidth={1.5} name="RSI" />
              </AreaChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* MACD */}
          <ChartCard title="MACD (12,26,9) — MOVING AVERAGE CONVERGENCE DIVERGENCE"
            legend={[{ label: "MACD", color: "#79c0ff" }, { label: "Signal", color: "#f85149" }, { label: "Histogram", color: "#39d353" }]}>
            <ResponsiveContainer width="100%" height={160}>
              <ComposedChart data={displayData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="date" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
                <YAxis stroke="#8b949e" fontSize={9} width={45} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="#30363d" />
                <Bar dataKey="macdHist" name="Histogram">
                  {displayData.map((d: Row, i: number) => (
                    <Cell key={i} fill={(d.macdHist ?? 0) >= 0 ? "#39d353" : "#f85149"} fillOpacity={0.7} />
                  ))}
                </Bar>
                <Line type="monotone" dataKey="macd" stroke="#79c0ff" strokeWidth={1.5} dot={false} name="MACD" />
                <Line type="monotone" dataKey="macdSignal" stroke="#f85149" strokeWidth={1.5} dot={false} name="Signal" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Volume */}
          <ChartCard title="VOLUME">
            <ResponsiveContainer width="100%" height={120}>
              <BarChart data={displayData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="date" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
                <YAxis stroke="#8b949e" fontSize={9} tickFormatter={(v: number) => (v / 1e6).toFixed(1) + "M"} width={45} />
                <Tooltip content={<CustomTooltip />} />
                <Bar dataKey="volume" fill="#58a6ff" opacity={0.6} name="Volume" />
              </BarChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* News + AI Sentiment */}
          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 1.5 }}>
                📰 NEWS-AWARE AI · {selectedStock}{sector ? ` · ${sector}` : ""}
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>SENTIMENT</span>
                <span style={{
                  fontSize: 11, fontWeight: 700, padding: "3px 8px", borderRadius: 4,
                  color: sentiment.label === "BULLISH" ? "#39d353" : sentiment.label === "BEARISH" ? "#f85149" : "#e3b341",
                  background: sentiment.label === "BULLISH" ? "rgba(57,211,83,0.1)" : sentiment.label === "BEARISH" ? "rgba(248,81,73,0.1)" : "rgba(227,179,65,0.1)",
                  border: `1px solid ${sentiment.label === "BULLISH" ? "#39d353" : sentiment.label === "BEARISH" ? "#f85149" : "#e3b341"}`,
                }}>{sentiment.label} {sentiment.score >= 0 ? "+" : ""}{sentiment.score.toFixed(2)}</span>
              </div>
            </div>
            {sentiment.summary && (
              <div style={{ fontSize: 11, color: "#e6edf3", lineHeight: 1.6, marginBottom: 8 }}>{sentiment.summary}</div>
            )}
            {sentiment.drivers.length > 0 && (
              <ul style={{ margin: "0 0 10px 16px", padding: 0, fontSize: 10, color: "#8b949e", lineHeight: 1.7 }}>
                {sentiment.drivers.map((d, i) => <li key={i}>{d}</li>)}
              </ul>
            )}
            <div style={{ display: "grid", gap: 6 }}>
              {newsItems.length === 0 && (
                <div style={{ fontSize: 10, color: "#8b949e" }}>Loading news…</div>
              )}
              {newsItems.slice(0, 12).map((n, i) => {
                const scopeColor =
                  n.scope === "company" ? "#58a6ff" :
                  n.scope === "sector" ? "#d2a8ff" :
                  n.scope === "market" ? "#ffa657" : "#8b949e";
                return (
                  <a key={i} href={n.link} target="_blank" rel="noreferrer"
                    style={{ display: "flex", gap: 8, padding: "6px 8px", background: "#010409", borderRadius: 4, textDecoration: "none", color: "#e6edf3", fontSize: 11, lineHeight: 1.4, border: "1px solid #161b22" }}>
                    <span style={{ fontSize: 8, fontWeight: 700, color: scopeColor, letterSpacing: 1, minWidth: 56, paddingTop: 2 }}>
                      {n.scope.toUpperCase()}
                    </span>
                    <span style={{ flex: 1 }}>
                      {n.title}
                      <span style={{ display: "block", fontSize: 9, color: "#8b949e", marginTop: 2 }}>
                        {n.publisher}{n.publishedAt ? ` · ${new Date(n.publishedAt * 1000).toLocaleString()}` : ""}
                      </span>
                    </span>
                  </a>
                );
              })}
            </div>
          </div>

          {/* Active alerts */}
          {alerts[selectedStock]?.length > 0 && (
            <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
              <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 1.5, marginBottom: 8 }}>ACTIVE ALERTS — {selectedStock}</div>
              {alerts[selectedStock].map((a, i) => (
                <div key={i} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "6px 8px", background: "#010409", borderRadius: 4, marginBottom: 4, fontSize: 11 }}>
                  <span>
                    <span style={{ color: a.type === "above" ? "#39d353" : "#f85149" }}>{a.type === "above" ? "▲" : "▼"}</span>
                    {" "}{selectedStock} {a.type} <span style={{ fontWeight: 600 }}>${a.price}</span>
                    {a.phone && <span style={{ color: "#8b949e" }}> → 📱 {a.phone}</span>}
                  </span>
                  <button onClick={() => setAlerts(prev => ({ ...prev, [selectedStock]: prev[selectedStock].filter((_, j) => j !== i) }))}
                    style={{ background: "transparent", border: "none", color: "#f85149", cursor: "pointer", fontSize: 14 }}>✕</button>
                </div>
              ))}
            </div>
          )}

          {/* SMS setup */}
          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12 }}>
            <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 1.5, marginBottom: 8 }}>📱 SMS ALERTS SETUP</div>
            <div style={{ fontSize: 11, color: "#8b949e", lineHeight: 1.7 }}>
              To enable real SMS alerts to your phone:<br />
              1. Sign up at twilio.com (free trial available)<br />
              2. Get your Account SID, Auth Token & phone number<br />
              3. Deploy a simple backend endpoint that calls Twilio's API when prices trigger<br />
              4. Set your phone number in the alert modal above<br />
              <span style={{ color: "#e3b341" }}>Alerts are tracked locally and shown above. Connect a backend to send live SMS.</span>
            </div>
          </div>
        </div>
      </div>

      {/* Alert Modal */}
      {showAlertModal && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(1,4,9,0.8)", display: "flex", alignItems: "center", justifyContent: "center", zIndex: 100, padding: 16 }}>
          <div style={{ background: "#0d1117", border: "1px solid #30363d", borderRadius: 10, padding: 20, maxWidth: 380, width: "100%", animation: "slideIn 0.2s" }}>
            <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 14, color: "#e6edf3" }}>SET PRICE ALERT — {selectedStock}</div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1, marginBottom: 6 }}>ALERT TYPE</div>
              <div style={{ display: "flex", gap: 6 }}>
                {(["above", "below"] as const).map(t => (
                  <button key={t} onClick={() => setAlertType(t)}
                    style={{ flex: 1, background: alertType === t ? "#21262d" : "transparent", border: `1px solid ${alertType === t ? "#58a6ff" : "#21262d"}`, borderRadius: 6, padding: "8px", fontSize: 11, color: alertType === t ? "#58a6ff" : "#8b949e", cursor: "pointer", textTransform: "uppercase", fontFamily: mono }}>
                    {t === "above" ? "▲ Price Above" : "▼ Price Below"}
                  </button>
                ))}
              </div>
            </div>

            <div style={{ marginBottom: 12 }}>
              <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1, marginBottom: 6 }}>TARGET PRICE (current: ${last.close?.toFixed(2)})</div>
              <input value={alertPrice} onChange={e => setAlertPrice(e.target.value)} type="number" step="0.01"
                placeholder={`e.g. ${(last.close * 1.05).toFixed(2)}`}
                style={{ width: "100%", background: "#010409", border: "1px solid #21262d", borderRadius: 6, padding: "8px 10px", color: "#e6edf3", fontSize: 12, outline: "none", fontFamily: mono }} />
            </div>

            <div style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1, marginBottom: 6 }}>PHONE NUMBER (for SMS)</div>
              <input value={phoneNumber} onChange={e => setPhoneNumber(e.target.value)} placeholder="+1 (555) 000-0000"
                style={{ width: "100%", background: "#010409", border: "1px solid #21262d", borderRadius: 6, padding: "8px 10px", color: "#e6edf3", fontSize: 12, outline: "none", fontFamily: mono }} />
            </div>

            <div style={{ display: "flex", gap: 8 }}>
              <button onClick={() => setShowAlertModal(false)}
                style={{ flex: 1, background: "transparent", border: "1px solid #21262d", borderRadius: 6, padding: "10px", fontSize: 12, color: "#8b949e", cursor: "pointer", fontFamily: mono }}>Cancel</button>
              <button onClick={addAlert} className="btn-primary"
                style={{ flex: 1, background: "#238636", border: "1px solid #2ea043", borderRadius: 6, padding: "10px", fontSize: 12, color: "#fff", cursor: "pointer", fontWeight: 600, fontFamily: mono }}>Set Alert 🔔</button>
            </div>
          </div>
        </div>
      )}

      {/* Notification */}
      {notification && (
        <div style={{ position: "fixed", top: 70, right: 16, background: "#0d1117", border: "1px solid #39d353", borderRadius: 6, padding: "10px 14px", fontSize: 11, color: "#e6edf3", animation: "slideIn 0.3s", zIndex: 101, maxWidth: 320 }}>
          {notification.msg}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, legend, children }: { title: string; legend?: { label: string; color: string }[]; children: React.ReactNode }) {
  return (
    <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
        <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 1.5 }}>{title}</div>
        {legend && (
          <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
            {legend.map(l => (
              <div key={l.label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 9, color: "#8b949e" }}>
                <div style={{ width: 10, height: 2, background: l.color }} />
                {l.label}
              </div>
            ))}
          </div>
        )}
      </div>
      {children}
    </div>
  );
}

function SchwabConnectButton() {
  const startAuth = useServerFn(getSchwabAuthUrl);
  const [connected, setConnected] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(SCHWAB_TOKEN_KEY);
      setConnected(!!raw);
    } catch {}
  }, []);

  const handleClick = async () => {
    if (connected) {
      if (confirm("Disconnect Schwab account?")) {
        localStorage.removeItem(SCHWAB_TOKEN_KEY);
        setConnected(false);
      }
      return;
    }
    setBusy(true);
    try {
      const redirectUri = `${window.location.origin}/auth/schwab/callback`;
      const { url } = await startAuth({ data: { redirectUri } });
      window.location.href = url;
    } catch (e) {
      alert(`Schwab connect failed: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };

  return (
    <button
      onClick={handleClick}
      disabled={busy}
      title={connected ? "Schwab connected — click to disconnect" : "Connect your Schwab / thinkorswim account for live 24/7 quotes"}
      style={{
        background: connected ? "#0d2a4d" : "#0d1117",
        border: `1px solid ${connected ? "#1f6feb" : "#21262d"}`,
        borderRadius: 6, padding: "6px 10px", minWidth: 110, cursor: busy ? "wait" : "pointer",
        color: connected ? "#79c0ff" : "#e6edf3", fontFamily: "inherit",
      }}
    >
      <div style={{ fontSize: 9, letterSpacing: 1 }}>SCHWAB</div>
      <div style={{ fontSize: 13, fontWeight: 800 }}>{busy ? "…" : connected ? "✓ CONNECTED" : "🔐 CONNECT"}</div>
    </button>
  );
}
