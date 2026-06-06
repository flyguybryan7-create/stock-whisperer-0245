import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getQuotes, searchSymbols, getLiveQuotes, getNews, analyzeNewsSentiment,
  getIntraday, getIntradayBatch,
  type Candle, type SymbolSearchResult, type LiveQuote, type NewsItem, type SentimentResult,
  type IntradayBar,
} from "@/lib/quotes.functions";
import { sendAlert, sendTestPush, subscribeToPush, unsubscribeFromPush } from "@/lib/push.functions";
import {
  pushSupported,
  registerSwAndSubscribe,
  getCurrentSubscriptionEndpoint,
  unsubscribeLocal,
  isPreviewIframe,
  type PushPermission,
} from "@/lib/push-client";
import { getShortInterest, type ShortInterest } from "@/lib/shortinterest.functions";
import { fetchAsiaSemis, fetchFastPulse, fetchMacroNews, fetchSemisPulse } from "@/lib/market-pulse.functions";
import type { QuoteSnap } from "@/lib/market-pulse.server";
import { useAuthUser } from "@/hooks/useAuthUser";
import { useSubscription } from "@/hooks/useSubscription";
import { supabase } from "@/integrations/supabase/client";
import { Link } from "@tanstack/react-router";
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, AreaChart, Area, ComposedChart, Bar, BarChart, Cell, Scatter,
} from "recharts";

const DEFAULT_STOCKS = [
  "NVDA","MRVL","SMTC","TSEM","CRDO","INTC","QBTS","INFQ","HUT","ALAB","AAOI","SNOW","NVTS","MCHP","ANET",
  "CRWV","CBRS","RMBS","LSCC","MXL","AMBA","PLAB","ASYS","COHU","NLST","ACLS","STM","SATS","WDC",
  "MU","AMD","PLTR","GOOG","APLD","ARM","TSM","OKLO","NTAP","AMZN","GSAT","NXPI","ORCL","SMCI",
  "CDNS","INOD","ACVA","AAL","JBLU","FHN","FRST","HBAN","RF","RRC","MJNA","NAK","BCTX","CMCSA",
  "CANF","TSLA","APO","AAPL","FUSE","CCJ","VST","NEE","SMR","XE","BEPC","NTRA","TEAM","GFS",
  "RGTI","XNDU","QUBT","IONQ","CLSK","HXL","SATL","ASTS","PL","LUNR","DELL","MX","IPWR","ACMR",
  "QUIK","PKE","INTT","IREN",
];
const WATCHLIST_KEY = "bryantrade.watchlist.v1";

const STOCK_NAMES: Record<string, string> = {
  NVDA:"NVIDIA Corp",MRVL:"Marvell Technology",SMTC:"Semtech Corp",TSEM:"Tower Semiconductor",
  INTC:"Intel Corp",QBTS:"D-Wave Quantum",INFQ:"Infleqtion Inc",HUT:"Hut 8 Corp",
  CRDO:"Credo Technology",ALAB:"Astera Labs",AAOI:"Applied Optoelectronics",SNOW:"Snowflake Inc",NVTS:"Navitas Semi",
  MCHP:"Microchip Tech",ANET:"Arista Networks",MU:"Micron Technology",AMD:"Advanced Micro",
  PLTR:"Palantir Tech",GOOG:"Alphabet Inc",APLD:"Applied Digital",ARM:"ARM Holdings",
  TSM:"Taiwan Semi",OKLO:"Oklo Inc",NTAP:"NetApp Inc",AMZN:"Amazon.com",
  GSAT:"Globalstar Inc",NXPI:"NXP Semiconductors",ORCL:"Oracle Corp",SMCI:"Super Micro",
  CRWV:"CoreWeave Inc",CBRS:"Cerebras Systems",RMBS:"Rambus Inc",LSCC:"Lattice Semi",
  MXL:"MaxLinear Inc",AMBA:"Ambarella Inc",PLAB:"Photronics Inc",ASYS:"Amtech Systems",
  COHU:"Cohu Inc",NLST:"Netlist Inc",ACLS:"Axcelis Tech",STM:"STMicroelectronics",
  SATS:"EchoStar Corp",WDC:"Western Digital",
  CDNS:"Cadence Design",INOD:"Innodata Inc",ACVA:"ACV Auctions",AAL:"American Airlines",
  JBLU:"JetBlue Airways",FHN:"First Horizon",FRST:"Primis Financial",HBAN:"Huntington Bancshares",
  RF:"Regions Financial",RRC:"Range Resources",MJNA:"Medical Marijuana",NAK:"Northern Dynasty",
  BCTX:"BriaCell Therapeutics",CMCSA:"Comcast Corp",CANF:"Can-Fite BioPharma",TSLA:"Tesla Inc",
  APO:"Apollo Global",AAPL:"Apple Inc",FUSE:"Fusion Fuel Green",CCJ:"Cameco Corp",
  VST:"Vistra Corp",NEE:"NextEra Energy",SMR:"NuScale Power",XE:"XCF Global",
  BEPC:"Brookfield Renewable",NTRA:"Natera Inc",TEAM:"Atlassian Corp",GFS:"GlobalFoundries",
  RGTI:"Rigetti Computing",XNDU:"Xanadu Quantum",QUBT:"Quantum Computing",IONQ:"IonQ Inc",
  CLSK:"CleanSpark Inc",HXL:"Hexcel Corp",SATL:"Satellogic Inc",ASTS:"AST SpaceMobile",
  PL:"Planet Labs",LUNR:"Intuitive Machines",DELL:"Dell Technologies",MX:"Magnachip Semi",
  IPWR:"Ideal Power",ACMR:"ACM Research",QUIK:"QuickLogic Corp",PKE:"Park Aerospace",
  INTT:"inTEST Corp",IREN:"IREN Limited",
};

type Row = {
  date: string; close: number; open: number; high: number; low: number; volume: number;
  sma9?: number | null; sma15?: number | null; sma50?: number | null; ema9?: number | null;
  rsi?: number | null; bbUpper?: number | null; bbMiddle?: number | null; bbLower?: number | null;
  macd?: number | null; macdSignal?: number | null; macdHist?: number | null;
  macdAlert?: "BUY" | "SELL" | "HOLD";
  macdBuyMark?: number | null;
  macdSellMark?: number | null;
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

// ============ MACD-only signal ============
// Classic MACD rules:
//   BUY  = MACD crosses above Signal (bullish crossover), confirmed by hist > 0
//   SELL = MACD crosses below Signal (bearish crossover), confirmed by hist < 0
//   HOLD = no crossover this bar
// We also annotate each bar so we can plot markers on the MACD chart.
export type MacdSignal = "BUY" | "SELL" | "HOLD";
export function macdSignalForBar(curr: Row, prev: Row | undefined): MacdSignal {
  if (!prev) return "HOLD";
  const m = curr.macd ?? null, s = curr.macdSignal ?? null;
  const pm = prev.macd ?? null, ps = prev.macdSignal ?? null;
  if (m == null || s == null || pm == null || ps == null) return "HOLD";
  const crossedUp = pm <= ps && m > s;
  const crossedDown = pm >= ps && m < s;
  if (crossedUp) return "BUY";
  if (crossedDown) return "SELL";
  return "HOLD";
}
export function annotateMacdSignals(data: Row[]): Row[] {
  return data.map((d, i) => {
    const sig = macdSignalForBar(d, data[i - 1]);
    return {
      ...d,
      macdAlert: sig,
      macdBuyMark: sig === "BUY" ? d.macd : null,
      macdSellMark: sig === "SELL" ? d.macd : null,
    } as Row;
  });
}
export function getCurrentMacdSignal(data: Row[]): { signal: MacdSignal; reason: string; barsAgo: number | null } {
  for (let i = data.length - 1; i >= Math.max(0, data.length - 20); i--) {
    const sig = macdSignalForBar(data[i], data[i - 1]);
    if (sig !== "HOLD") {
      const m = data[i].macd ?? 0, s = data[i].macdSignal ?? 0;
      const barsAgo = data.length - 1 - i;
      return {
        signal: sig,
        reason: `${sig === "BUY" ? "Bullish" : "Bearish"} crossover ${barsAgo === 0 ? "now" : `${barsAgo} bar${barsAgo === 1 ? "" : "s"} ago`} · MACD ${m.toFixed(3)} ${sig === "BUY" ? ">" : "<"} Signal ${s.toFixed(3)}`,
        barsAgo,
      };
    }
  }
  return { signal: "HOLD", reason: "No recent MACD crossover", barsAgo: null };
}

export function getMacdMomentumSignal(data: Row[]): { signal: MacdSignal; reason: string } {
  const last = data[data.length - 1];
  const prev = data[data.length - 2];
  if (!last || !prev) return { signal: "HOLD", reason: "Not enough MACD data" };

  const macd = last.macd ?? null;
  const signal = last.macdSignal ?? null;
  const prevMacd = prev.macd ?? null;
  const prevSignal = prev.macdSignal ?? null;
  const hist = last.macdHist ?? null;
  const prevHist = prev.macdHist ?? null;

  if (macd == null || signal == null || prevMacd == null || prevSignal == null || hist == null || prevHist == null) {
    return { signal: "HOLD", reason: "MACD still forming" };
  }

  const crossover = macdSignalForBar(last, prev);
  const macdSlopeUp = macd > prevMacd;
  const macdSlopeDown = macd < prevMacd;
  const signalSlopeUp = signal > prevSignal;
  const signalSlopeDown = signal < prevSignal;
  const histRising = hist > prevHist;
  const histFalling = hist < prevHist;

  if (crossover === "BUY" || (macd > signal && macdSlopeUp && histRising)) {
    return {
      signal: "BUY",
      reason:
        crossover === "BUY"
          ? `Bullish crossover now · MACD ${macd.toFixed(3)} above Signal ${signal.toFixed(3)}`
          : `MACD rising above Signal with improving momentum · ${macd.toFixed(3)} vs ${signal.toFixed(3)}`,
    };
  }

  if (crossover === "SELL" || (macd < signal && macdSlopeDown && histFalling)) {
    return {
      signal: "SELL",
      reason:
        crossover === "SELL"
          ? `Bearish crossover now · MACD ${macd.toFixed(3)} below Signal ${signal.toFixed(3)}`
          : `MACD falling below Signal with weakening momentum · ${macd.toFixed(3)} vs ${signal.toFixed(3)}`,
    };
  }

  if ((macdSlopeUp && signalSlopeUp) || (macdSlopeDown && signalSlopeDown)) {
    return { signal: "HOLD", reason: "Momentum is moving, but MACD and Signal have not separated enough" };
  }

  return { signal: "HOLD", reason: "MACD momentum is flat" };
}

// ============ Market hours + breakout helpers ============
// US regular session: Mon–Fri 09:30–16:00 America/New_York.
function isUsMarketOpen(now: Date = new Date()): boolean {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? "";
  const wd = get("weekday");
  if (wd === "Sat" || wd === "Sun") return false;
  const h = parseInt(get("hour"), 10);
  const m = parseInt(get("minute"), 10);
  const mins = h * 60 + m;
  return mins >= 9 * 60 + 30 && mins < 16 * 60;
}

// Breakout = today's close pushes through the prior N-day high (BUY)
// or N-day low (SELL), with confirming volume when available.
function isBreakout(data: Row[], side: "BUY" | "SELL", lookback = 20): boolean {
  if (data.length < lookback + 1) return false;
  const last = data[data.length - 1];
  const window = data.slice(-1 - lookback, -1); // prior N bars, exclude today
  if (!last || window.length === 0) return false;
  const priorHigh = Math.max(...window.map((d) => (d as any).high ?? d.close));
  const priorLow = Math.min(...window.map((d) => (d as any).low ?? d.close));
  if (side === "BUY") return last.close > priorHigh;
  return last.close < priorLow;
}

// ============ Intraday day-trade signal ============
// Uses 1m bars: EMA9 vs EMA21 cross, VWAP position, short RSI(7), momentum.
function getDayTradeSignal(bars: IntradayBar[]): {
  signal: "BUY" | "SELL" | "HOLD";
  reason: string;
  rsi: number | null;
  vwap: number | null;
  emaFast: number | null;
  emaSlow: number | null;
} {
  if (!bars || bars.length < 25) {
    return { signal: "HOLD", reason: "Not enough intraday data", rsi: null, vwap: null, emaFast: null, emaSlow: null };
  }
  // EMA helper
  const ema = (period: number) => {
    const k = 2 / (period + 1);
    let e = bars[0].close;
    const arr: number[] = [];
    for (let i = 0; i < bars.length; i++) {
      e = i === 0 ? bars[i].close : bars[i].close * k + e * (1 - k);
      arr.push(e);
    }
    return arr;
  };
  const fast = ema(9);
  const slow = ema(21);
  // RSI(7)
  const period = 7;
  let avgG = 0, avgL = 0;
  for (let i = 1; i <= period; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    if (ch > 0) avgG += ch; else avgL += -ch;
  }
  avgG /= period; avgL /= period;
  for (let i = period + 1; i < bars.length; i++) {
    const ch = bars[i].close - bars[i - 1].close;
    avgG = (avgG * (period - 1) + Math.max(ch, 0)) / period;
    avgL = (avgL * (period - 1) + Math.max(-ch, 0)) / period;
  }
  const rs = avgL === 0 ? 100 : avgG / avgL;
  const rsi = +(100 - 100 / (1 + rs)).toFixed(1);
  // VWAP (regular session approx — uses all bars)
  let pv = 0, vv = 0;
  for (const b of bars) {
    const typical = (b.high + b.low + b.close) / 3;
    pv += typical * b.volume;
    vv += b.volume;
  }
  const vwap = vv > 0 ? +(pv / vv).toFixed(2) : null;
  const last = bars[bars.length - 1].close;
  const prev = bars[bars.length - 2].close;
  const fastL = fast[fast.length - 1], fastP = fast[fast.length - 2];
  const slowL = slow[slow.length - 1], slowP = slow[slow.length - 2];
  const crossUp = fastP <= slowP && fastL > slowL;
  const crossDown = fastP >= slowP && fastL < slowL;
  const aboveVwap = vwap != null && last > vwap;
  const momentum = ((last - bars[Math.max(0, bars.length - 6)].close) / bars[Math.max(0, bars.length - 6)].close) * 100;
  let bull = 0, bear = 0;
  const reasons: string[] = [];
  if (crossUp) { bull += 3; reasons.push("EMA9↑21 cross"); }
  if (crossDown) { bear += 3; reasons.push("EMA9↓21 cross"); }
  if (fastL > slowL) bull += 1; else bear += 1;
  if (rsi < 30) { bull += 2; reasons.push(`RSI ${rsi} oversold`); }
  if (rsi > 70) { bear += 2; reasons.push(`RSI ${rsi} overbought`); }
  if (aboveVwap) { bull += 1; reasons.push(`Above VWAP ${vwap}`); }
  else if (vwap != null) { bear += 1; reasons.push(`Below VWAP ${vwap}`); }
  if (momentum > 0.3) { bull += 1; reasons.push(`+${momentum.toFixed(2)}% 5m`); }
  if (momentum < -0.3) { bear += 1; reasons.push(`${momentum.toFixed(2)}% 5m`); }
  if (last > prev) bull += 1; else if (last < prev) bear += 1;
  let signal: "BUY" | "SELL" | "HOLD" = "HOLD";
  if (bull >= bear + 3) signal = "BUY";
  else if (bear >= bull + 3) signal = "SELL";
  return {
    signal,
    reason: reasons.slice(0, 3).join(" · ") || "Mixed signals",
    rsi,
    vwap,
    emaFast: +fastL.toFixed(2),
    emaSlow: +slowL.toFixed(2),
  };
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

type Alert = { price: number; type: "above" | "below"; active: boolean };

export default function TradingPlatform() {
  const [watchlist, setWatchlist] = useState<string[]>(DEFAULT_STOCKS);
  const { user } = useAuthUser();
  const { tier } = useSubscription(user?.id);
  const isPro = tier === "pro";
  const [stockNames, setStockNames] = useState<Record<string, string>>(STOCK_NAMES);
  const [selectedStock, setSelectedStock] = useState("MRVL");
  const [search, setSearch] = useState("");
  const [searchFocused, setSearchFocused] = useState(false);
  const [alerts, setAlerts] = useState<Record<string, Alert[]>>({});
  // SMS/text alerts removed — push only
  const [showAlertModal, setShowAlertModal] = useState(false);
  const [alertPrice, setAlertPrice] = useState("");
  const [alertType, setAlertType] = useState<"above" | "below">("above");
  const [notification, setNotification] = useState<{ msg: string } | null>(null);
  const [chartRange, setChartRange] = useState(60);
  const [chartMode, setChartMode] = useState<"D" | "INTRADAY">("INTRADAY");
  const [intradayRange, setIntradayRange] = useState<"1D" | "2D" | "5D">("1D");
  const [intradayInterval, setIntradayInterval] = useState<"1m" | "5m" | "15m">("1m");
  const [pushPerm, setPushPerm] = useState<PushPermission>("default");
  const [pushBusy, setPushBusy] = useState(false);
  const lastPushSignal = useRef<Record<string, "BUY" | "SELL">>({});
  // Tracks the last big-move direction we alerted for, so we don't spam
  // notifications for the same symbol while it stays above the ±5% threshold.
  const lastBigMove = useRef<Record<string, "UP" | "DOWN" | null>>({});
  // Flow-surge dedupe: only fire one push per symbol per direction until it
  // falls back to neutral.
  const lastFlowSurge = useRef<Record<string, "BUY_SURGE" | "SELL_SURGE" | null>>({});

  // Load persisted watchlist from localStorage on first mount (fast path / signed-out users)
  const hydratedFromCloud = useRef(false);
  useEffect(() => {
    try {
      const raw = localStorage.getItem(WATCHLIST_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as { symbols?: string[]; names?: Record<string, string> };
        if (parsed.symbols?.length) {
          const existing = parsed.symbols;
          const missing = DEFAULT_STOCKS.filter((s) => !existing.includes(s));
          setWatchlist(missing.length ? [...existing, ...missing] : existing);
        }
        if (parsed.names) setStockNames((s) => ({ ...s, ...parsed.names }));
      }
    } catch {}
  }, []);

  // When signed in, pull cloud watchlist and merge local additions up to the cloud
  useEffect(() => {
    if (!user?.id) { hydratedFromCloud.current = false; return; }
    let cancelled = false;
    (async () => {
      const { data } = await supabase
        .from("watchlists")
        .select("symbols, names")
        .eq("user_id", user.id)
        .maybeSingle();
      if (cancelled) return;
      if (data?.symbols?.length) {
        const existing = data.symbols;
        const missing = DEFAULT_STOCKS.filter((s) => !existing.includes(s));
        setWatchlist(missing.length ? [...existing, ...missing] : existing);
        if (data.names && typeof data.names === "object") {
          setStockNames((s) => ({ ...s, ...(data.names as Record<string, string>) }));
        }
      } else {
        // No cloud row yet — seed it from whatever is currently loaded (localStorage/defaults)
        await supabase.from("watchlists").upsert({
          user_id: user.id,
          symbols: watchlist,
          names: stockNames,
          updated_at: new Date().toISOString(),
        });
      }
      hydratedFromCloud.current = true;
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user?.id]);

  // Persist changes: always to localStorage; also to cloud when signed in
  useEffect(() => {
    try {
      localStorage.setItem(WATCHLIST_KEY, JSON.stringify({ symbols: watchlist, names: stockNames }));
    } catch {}
    if (!user?.id || !hydratedFromCloud.current) return;
    const t = setTimeout(() => {
      supabase.from("watchlists").upsert({
        user_id: user.id,
        symbols: watchlist,
        names: stockNames,
        updated_at: new Date().toISOString(),
      }).then(() => {});
    }, 400);
    return () => clearTimeout(t);
  }, [watchlist, stockNames, user?.id]);

  const fetchQuotes = useServerFn(getQuotes);
  const fetchSearch = useServerFn(searchSymbols);
  const fetchLive = useServerFn(getLiveQuotes);
  const fetchNews = useServerFn(getNews);
  const fetchSentiment = useServerFn(analyzeNewsSentiment);
  const fetchIntraday = useServerFn(getIntraday);
  const fetchIntradayBatch = useServerFn(getIntradayBatch);
  const firePush = useServerFn(sendAlert);
  const fireTestPush = useServerFn(sendTestPush);
  const callSubscribe = useServerFn(subscribeToPush);
  const callUnsubscribe = useServerFn(unsubscribeFromPush);
  const fetchShort = useServerFn(getShortInterest);
  const fetchAsiaSemisFn = useServerFn(fetchAsiaSemis);
  const fetchMacroNewsFn = useServerFn(fetchMacroNews);
  const fetchFastPulseFn = useServerFn(fetchFastPulse);
  const fetchSemisPulseFn = useServerFn(fetchSemisPulse);

  // Reflect current notification permission + existing subscription.
  useEffect(() => {
    if (!pushSupported()) { setPushPerm("unsupported"); return; }
    setPushPerm(Notification.permission as PushPermission);
  }, []);

  const togglePush = async () => {
    if (!pushSupported()) {
      showNotif("Notifications not supported on this device");
      return;
    }
    if (isPreviewIframe()) {
      showNotif("Open the published app in Safari/Chrome to enable notifications");
      return;
    }
    setPushBusy(true);
    try {
      // If iOS/Safari has the permission permanently denied, requestPermission()
      // resolves "denied" instantly and we can never re-prompt from JS. The user
      // has to flip it in iOS Settings.
      if (Notification.permission === "denied") {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        showNotif(
          isIOS
            ? "iOS blocked alerts. Open iOS Settings → Notifications → BryanTrade and turn Allow Notifications back on."
            : "Notifications blocked. Enable them in your browser site settings, then try again.",
        );
        return;
      }

      if (Notification.permission === "granted") {
        // Already granted: make sure we actually have a push subscription on
        // this device. If the previous one was cleared (iOS often drops it
        // after a PWA reinstall), re-subscribe instead of toggling off.
        const existing = await getCurrentSubscriptionEndpoint();
        if (!existing) {
          const sub = await registerSwAndSubscribe();
          if (!sub) throw new Error("subscription failed");
          await callSubscribe({
            data: { ...sub, userAgent: navigator.userAgent.slice(0, 200) },
          });
          setPushPerm("granted");
          showNotif("🔔 Push notifications re-enabled");
          return;
        }
        // Subscription exists → user is toggling off.
        const endpoint = await unsubscribeLocal();
        if (endpoint) await callUnsubscribe({ data: { endpoint } });
        setPushPerm("default");
        showNotif("🔕 Push notifications disabled on this device");
        return;
      }

      // permission === "default" → request it.
      const perm = await Notification.requestPermission();
      setPushPerm(perm as PushPermission);
      if (perm !== "granted") {
        const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
        showNotif(
          isIOS
            ? "iOS blocked alerts. Open iOS Settings → Notifications → BryanTrade and turn Allow Notifications on."
            : "Notifications denied — enable in browser settings",
        );
        return;
      }
      const sub = await registerSwAndSubscribe();
      if (!sub) throw new Error("subscription failed");
      await callSubscribe({
        data: { ...sub, userAgent: navigator.userAgent.slice(0, 200) },
      });
      showNotif("🔔 Push notifications enabled");
    } catch (e) {
      showNotif(`Push setup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setPushBusy(false);
    }
  };

  const sendTest = async () => {
    try {
      const r = await fireTestPush();
      showNotif(`Test sent to ${("sent" in r ? (r as { sent?: number }).sent ?? 0 : 0)} device(s)`);
    } catch (e) {
      showNotif(`Test failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  };

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

  // Asia semiconductor sector pulse — refresh every 5 minutes.
  const { data: asiaSemis } = useQuery({
    queryKey: ["asiaSemis"],
    queryFn: () => fetchAsiaSemisFn(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Macro market-moving news (CNBC / MarketWatch / WSJ) — refresh every 5 minutes.
  const { data: macroNews } = useQuery({
    queryKey: ["macroNews"],
    queryFn: () => fetchMacroNewsFn(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Split market pulse into two lanes so each can refresh at max safe speed:
  //   • fastPulse  = futures (ES/NQ/YM/RTY) + VIX  → 5 symbols → 2s
  //   • semisPulse = SOXX + SMH + 12-name basket + risk gauge → 15 symbols → 3s
  // The per-symbol quote stream still runs at 1s and the watchlist intraday
  // batch at 3s — those drive the flash alerts.
  const { data: fastPulse } = useQuery({
    queryKey: ["fastPulse"],
    queryFn: () => fetchFastPulseFn(),
    staleTime: 1_500,
    refetchInterval: 2_000,
    refetchIntervalInBackground: true,
  });
  const { data: semisPulse } = useQuery({
    queryKey: ["semisPulse"],
    queryFn: () => fetchSemisPulseFn(),
    staleTime: 2_500,
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
  });
  const marketPulse = useMemo(() => {
    if (!fastPulse && !semisPulse) return undefined;
    return {
      futures: fastPulse?.futures ?? [],
      vix: fastPulse?.vix ?? null,
      semisEtfs: semisPulse?.semisEtfs ?? [],
      semisBreadth: semisPulse?.semisBreadth ?? { advancers: 0, decliners: 0, unchanged: 0, avgChangePct: null, components: [] as QuoteSnap[] },
      semisRisk: semisPulse?.semisRisk ?? null,
    };
  }, [fastPulse, semisPulse]);

  // News for selected stock
  const { data: newsData } = useQuery({
    queryKey: ["news", selectedStock, stockNames[selectedStock] || ""],
    queryFn: () => fetchNews({ data: { symbol: selectedStock, companyName: stockNames[selectedStock] } }),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    enabled: !!selectedStock,
  });
  const newsItems: NewsItem[] = (newsData?.items ?? []).filter((n) => n.scope === "company");
  const sector = newsData?.sector ?? null;

  const intradayRequest = useMemo(
    () => ({
      symbol: selectedStock,
      interval: intradayInterval,
      range: intradayRange.toLowerCase() as "1d" | "2d" | "5d",
    }),
    [selectedStock, intradayInterval, intradayRange],
  );

  // Intraday bars drive both the live signal and intraday charting.
  const { data: intradayData } = useQuery({
    queryKey: ["intraday", selectedStock, intradayRange, intradayInterval],
    queryFn: () => fetchIntraday({ data: intradayRequest }),
    refetchInterval: 15_000,
    enabled: !!selectedStock,
  });
  const intradayBars: IntradayBar[] = intradayData ?? [];
  const dayTrade = useMemo(() => getDayTradeSignal(intradayBars), [intradayBars]);

  // Intraday bars for every watchlist symbol — refreshed every 3s so the
  // BUY/SELL/HOLD badges next to each ticker react to live MACD momentum.
  const { data: watchlistIntradayData } = useQuery({
    queryKey: ["intradayBatch", [...watchlist].sort().join(",")],
    queryFn: () => fetchIntradayBatch({ data: { symbols: watchlist, interval: "1m", range: "2d" } }),
    refetchInterval: 3_000,
    refetchIntervalInBackground: true,
    staleTime: 2_000,
    enabled: watchlist.length > 0,
  });
  const watchlistMacdSignals = useMemo(() => {
    const out: Record<string, "BUY" | "SELL" | "HOLD"> = {};
    const batch = (watchlistIntradayData ?? {}) as Record<string, IntradayBar[]>;
    for (const sym of Object.keys(batch)) {
      const bars = batch[sym] ?? [];
      if (bars.length < 5) continue;
      const rows: Row[] = bars.map((b) => ({
        date: String(b.t), close: b.close, open: b.open, high: b.high, low: b.low, volume: b.volume,
      }));
      const annotated = annotateMacdSignals(buildChartData(rows));
      out[sym] = getMacdMomentumSignal(annotated).signal;
    }
    return out;
  }, [watchlistIntradayData]);

  // Per-symbol intraday VWAP for the watchlist (typical-price * volume / volume).
  const watchlistVwap = useMemo(() => {
    const out: Record<string, number> = {};
    const batch = (watchlistIntradayData ?? {}) as Record<string, IntradayBar[]>;
    for (const sym of Object.keys(batch)) {
      const bars = batch[sym] ?? [];
      if (bars.length === 0) continue;
      // Anchor VWAP to the most recent trading day so it updates as today progresses
      // (range="2d" returns yesterday + today; we only want today's session).
      const lastTs = bars[bars.length - 1].t;
      const lastDay = new Date(lastTs * 1000).toDateString();
      const todayBars = bars.filter((b) => new Date(b.t * 1000).toDateString() === lastDay);
      let pv = 0, vv = 0;
      for (const b of todayBars) {
        const typical = (b.high + b.low + b.close) / 3;
        pv += typical * b.volume;
        vv += b.volume;
      }
      if (vv > 0) out[sym] = +(pv / vv).toFixed(2);
    }
    return out;
  }, [watchlistIntradayData]);

  // Real-time order-flow pressure detector. For each watchlist symbol we look
  // at the most recent 1-minute bar versus the prior 20-bar average volume.
  // A "surge" fires when current-minute volume is ≥3× the 20-bar mean AND the
  // bar moved ≥0.25% in the same direction — i.e. aggressive buying or
  // aggressive selling, distinct from a slower MACD buy/sell crossover.
  type FlowSignal = { kind: "BUY_SURGE" | "SELL_SURGE"; volRatio: number; pricePct: number } | null;
  const flowSignals = useMemo(() => {
    const out: Record<string, FlowSignal> = {};
    const batch = (watchlistIntradayData ?? {}) as Record<string, IntradayBar[]>;
    for (const sym of Object.keys(batch)) {
      const bars = batch[sym] ?? [];
      if (bars.length < 22) { out[sym] = null; continue; }
      // Only consider today's bars so yesterday's open doesn't pollute.
      const lastTs = bars[bars.length - 1].t;
      const lastDay = new Date(lastTs * 1000).toDateString();
      const today = bars.filter((b) => new Date(b.t * 1000).toDateString() === lastDay);
      if (today.length < 5) { out[sym] = null; continue; }
      const cur = today[today.length - 1];
      const prior = today.slice(Math.max(0, today.length - 21), today.length - 1);
      if (prior.length < 5) { out[sym] = null; continue; }
      const avgVol = prior.reduce((s, b) => s + (b.volume || 0), 0) / prior.length;
      if (avgVol <= 0 || !cur.volume) { out[sym] = null; continue; }
      const volRatio = cur.volume / avgVol;
      const pricePct = cur.open > 0 ? ((cur.close - cur.open) / cur.open) * 100 : 0;
      if (volRatio >= 3 && pricePct >= 0.25) {
        out[sym] = { kind: "BUY_SURGE", volRatio, pricePct };
      } else if (volRatio >= 3 && pricePct <= -0.25) {
        out[sym] = { kind: "SELL_SURGE", volRatio, pricePct };
      } else {
        out[sym] = null;
      }
    }
    return out;
  }, [watchlistIntradayData]);

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

  const dailyChartData = allData[selectedStock] || [];
  // Convert intraday bars -> Row[] (same shape) so we can reuse buildChartData/charts.
  const intradayRows: Row[] = useMemo(() => {
    const bars = intradayBars;
    if (!bars.length) return [];
    const rows: Row[] = bars.map((b) => ({
      date: new Date(b.t * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      close: b.close, open: b.open, high: b.high, low: b.low, volume: b.volume,
    }));
    return buildChartData(rows);
  }, [intradayBars]);

  const chartData = chartMode === "D" ? dailyChartData : intradayRows;
  const displayDataRaw = chartMode === "D" ? chartData.slice(-chartRange) : chartData;
  const displayData = useMemo(() => annotateMacdSignals(displayDataRaw), [displayDataRaw]);
  const macdCurrent = useMemo(() => getCurrentMacdSignal(displayData), [displayData]);
  const selectedLiveMacdRows = useMemo(() => {
    const batch = (watchlistIntradayData ?? {}) as Record<string, IntradayBar[]>;
    const bars = batch[selectedStock] ?? [];
    if (bars.length < 5) return [] as Row[];
    return annotateMacdSignals(buildChartData(bars.map((b) => ({
      date: new Date(b.t * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      close: b.close,
      open: b.open,
      high: b.high,
      low: b.low,
      volume: b.volume,
    }))));
  }, [watchlistIntradayData, selectedStock]);
  const liveMacdSignal = useMemo(
    () => (selectedLiveMacdRows.length >= 5 ? getMacdMomentumSignal(selectedLiveMacdRows) : getMacdMomentumSignal(dailyChartData)),
    [selectedLiveMacdRows, dailyChartData],
  );
  // Show only the most recent ~3 hours on the MACD chart so the crossover
  // structure is readable. Daily mode keeps the full visible range.
  const macdDisplayData = useMemo(() => {
    if (chartMode === "D") return displayData;
    const minutesPerBar = parseInt(intradayInterval) || 5;
    const bars = Math.max(12, Math.ceil(180 / minutesPerBar));
    return displayData.slice(-bars);
  }, [displayData, chartMode, intradayInterval]);
  const last = chartData[chartData.length - 1] || ({} as Row);
  const prev = chartData[chartData.length - 2] || ({} as Row);
  const liveSel = live[selectedStock];
  const change = liveSel ? liveSel.change : (last.close && prev.close ? last.close - prev.close : 0);
  const changePct = liveSel ? liveSel.changePercent : (prev.close ? (change / prev.close) * 100 : 0);
  const signal = liveMacdSignal.signal;
  const signalFrameLabel = selectedLiveMacdRows.length >= 5 ? "MACD live · 3s refresh" : "MACD daily fallback";

  // Watch every watchlist symbol; when its signal flips to BUY or SELL,
  // fire a web push to every subscribed device (5-min server-side cooldown).
  useEffect(() => {
    if (pushPerm !== "granted") return;
    // Only during US regular trading hours, and only on breakout signals.
    if (!isUsMarketOpen()) return;
    for (const sym of Object.keys(allData)) {
      const series = allData[sym];
      if (!series || series.length === 0) continue;
      const sig = getSignal(series, sym === selectedStock ? sentiment.score : 0);
      if (sig !== "BUY" && sig !== "SELL") continue;
      if (lastPushSignal.current[sym] === sig) continue;
      if (!isBreakout(series, sig)) continue;
      lastPushSignal.current[sym] = sig;
      const lq = live[sym];
      const px = lq?.price ?? series[series.length - 1]?.close;
      if (px == null) continue;
      firePush({
        data: {
          symbol: sym,
          signal: sig,
          price: px,
          reason:
            `Breakout ${sig === "BUY" ? "↑ above" : "↓ below"} 20-day ${sig === "BUY" ? "high" : "low"}` +
            (sym === selectedStock && sentiment.summary ? ` · ${sentiment.summary.slice(0, 60)}` : ""),
        },
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveQuotes, rawQuotes, pushPerm, sentiment.score]);

  // Separate alert: any watchlist stock that moves more than ±5% intraday
  // during US regular trading hours. Fires once per direction per symbol;
  // resets when the move falls back inside ±5%.
  useEffect(() => {
    if (pushPerm !== "granted") return;
    if (!isUsMarketOpen()) return;
    for (const sym of watchlist) {
      const lq = live[sym];
      if (!lq || typeof lq.changePercent !== "number") continue;
      const pct = lq.changePercent;
      const dir: "UP" | "DOWN" | null = pct >= 5 ? "UP" : pct <= -5 ? "DOWN" : null;
      if (!dir) {
        lastBigMove.current[sym] = null;
        continue;
      }
      if (lastBigMove.current[sym] === dir) continue;
      lastBigMove.current[sym] = dir;
      firePush({
        data: {
          symbol: sym,
          signal: dir === "UP" ? "BUY" : "SELL",
          price: lq.price,
          reason: `Intraday ${dir === "UP" ? "↑" : "↓"} ${pct.toFixed(2)}% (>5% move)`,
        },
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveQuotes, pushPerm, watchlist]);

  // Order-flow surge alert: when a watchlist symbol shows MASSIVE BUYING or
  // MASSIVE SELLING on the current minute (≥3× avg minute volume, ≥0.25%
  // move on the bar), fire a push so the user gets pinged in addition to
  // the on-screen flashing ticker.
  useEffect(() => {
    if (pushPerm !== "granted") return;
    if (!isUsMarketOpen()) return;
    for (const sym of Object.keys(flowSignals)) {
      const flow = flowSignals[sym];
      if (!flow) { lastFlowSurge.current[sym] = null; continue; }
      if (lastFlowSurge.current[sym] === flow.kind) continue;
      lastFlowSurge.current[sym] = flow.kind;
      const lq = live[sym];
      const px = lq?.price;
      if (px == null) continue;
      firePush({
        data: {
          symbol: sym,
          signal: flow.kind === "BUY_SURGE" ? "BUY" : "SELL",
          price: px,
          reason:
            (flow.kind === "BUY_SURGE" ? "MASSIVE BUYING " : "MASSIVE SELLING ") +
            `· ${flow.volRatio.toFixed(1)}× avg minute volume · ${flow.pricePct >= 0 ? "+" : ""}${flow.pricePct.toFixed(2)}% on the bar`,
        },
      }).catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [flowSignals, pushPerm]);

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

  // iPhone-safe watchlist reorder: tap the handle once, then tap the row
  // where that stock should move. This avoids Safari long-press selection.
  const [reorderModeSym, setReorderModeSym] = useState<string | null>(null);

  const reorderTo = (src: string, target: string) => {
    if (!target || src === target) return;
    setWatchlist((prev) => {
      const srcIdx = prev.indexOf(src);
      const tgtIdx = prev.indexOf(target);
      if (srcIdx < 0 || tgtIdx < 0) return prev;
      const next = prev.slice();
      next.splice(srcIdx, 1);
      next.splice(tgtIdx, 0, src);
      return next;
    });
  };

  const toggleReorderMode = (sym: string) => {
    setReorderModeSym((prev) => prev === sym ? null : sym);
    if (typeof navigator !== "undefined" && "vibrate" in navigator) {
      try { navigator.vibrate?.(15); } catch {}
    }
  };

  const onWatchlistRowClick = (sym: string) => {
    if (reorderModeSym && reorderModeSym !== sym) {
      reorderTo(reorderModeSym, sym);
      setReorderModeSym(null);
      return;
    }
    if (reorderModeSym === sym) return;
    setSelectedStock(sym);
  };

  const showNotif = (msg: string) => {
    setNotification({ msg });
    setTimeout(() => setNotification(null), 3000);
  };

  const addAlert = () => {
    if (!alertPrice) return;
    const newAlert: Alert = { price: parseFloat(alertPrice), type: alertType, active: true };
    setAlerts(prev => ({ ...prev, [selectedStock]: [...(prev[selectedStock] || []), newAlert] }));
    setShowAlertModal(false);
    setAlertPrice("");
    showNotif(`Alert set for ${selectedStock} ${alertType} $${alertPrice} (push)`);
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
        @keyframes flashBuy {
          0%,100% { background: rgba(57,211,83,0.85); box-shadow: 0 0 12px rgba(57,211,83,0.9), 0 0 22px rgba(57,211,83,0.55); color: #03110a; }
          50%     { background: rgba(57,211,83,0.25); box-shadow: 0 0 4px rgba(57,211,83,0.4); color: #39d353; }
        }
        @keyframes flashSell {
          0%,100% { background: rgba(248,81,73,0.9); box-shadow: 0 0 12px rgba(248,81,73,0.95), 0 0 22px rgba(248,81,73,0.6); color: #1a0303; }
          50%     { background: rgba(248,81,73,0.25); box-shadow: 0 0 4px rgba(248,81,73,0.45); color: #f85149; }
        }
        .flow-flash-buy  { animation: flashBuy 0.7s ease-in-out infinite; padding: 0 4px; border-radius: 3px; font-weight: 900 !important; }
        .flow-flash-sell { animation: flashSell 0.7s ease-in-out infinite; padding: 0 4px; border-radius: 3px; font-weight: 900 !important; }
      `}</style>

      {/* Header */}
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 16px", borderBottom: "1px solid #21262d", background: "#0d1117" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <div style={{ fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 16, color: "#58a6ff", letterSpacing: 1 }}>⬡ BRYANTRADE</div>
          <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 2 }}>PRO TERMINAL</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          {marketPulse?.semisRisk && (() => {
            const r = marketPulse.semisRisk;
            const color = r.level === "EXTREME" ? "#f85149" : r.level === "HIGH" ? "#ff7b29" : r.level === "ELEVATED" ? "#e3b341" : "#39d353";
            return (
              <span title={`Semis sector risk gauge — ${r.level} (${r.score}/100)\n${r.reason}`}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 800, color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 6px", letterSpacing: 0.5 }}>
                <span style={{ color: "#8b949e", fontWeight: 800 }}>SEMI RISK</span>
                {r.level} <span style={{ opacity: 0.7 }}>{r.score}</span>
              </span>
            );
          })()}
          {marketPulse?.vix?.price != null && (() => {
            const v = marketPulse.vix;
            const pct = v.changePct ?? 0;
            const color = (v.price ?? 0) >= 22 ? "#f85149" : (v.price ?? 0) >= 18 ? "#e3b341" : "#39d353";
            return (
              <span title={`CBOE Volatility Index (fear gauge)`}
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 6px" }}>
                <span style={{ color: "#8b949e", fontWeight: 800 }}>VIX</span>
                {v.price!.toFixed(2)} <span style={{ opacity: 0.7 }}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</span>
              </span>
            );
          })()}
          {marketPulse?.futures && marketPulse.futures.length > 0 && (
            <span style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 10, fontWeight: 700, border: "1px solid #21262d", borderRadius: 4, padding: "2px 6px" }}>
              <span style={{ color: "#8b949e", fontWeight: 800 }}>FUT</span>
              {marketPulse.futures.map((f: QuoteSnap) => {
                const pct = f.changePct ?? 0;
                const color = pct >= 0 ? "#39d353" : "#f85149";
                const label = f.symbol === "ES=F" ? "ES" : f.symbol === "NQ=F" ? "NQ" : f.symbol === "YM=F" ? "YM" : "RTY";
                return (
                  <span key={f.symbol} title={`${f.name} futures: ${f.price?.toFixed(2) ?? "—"}`} style={{ color }}>
                    {label} {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                  </span>
                );
              })}
            </span>
          )}
          {marketPulse?.semisBreadth && marketPulse.semisBreadth.components.length > 0 && (() => {
            const b = marketPulse.semisBreadth;
            const total = b.advancers + b.decliners + b.unchanged;
            const tip = b.components.map((c: QuoteSnap) => `${c.symbol}: ${c.changePct == null ? "—" : (c.changePct >= 0 ? "+" : "") + c.changePct.toFixed(2) + "%"}`).join("\n");
            return (
              <span title={`US semis breadth (12-name basket)\n${tip}`}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 800, border: "1px solid #21262d", borderRadius: 4, padding: "2px 6px" }}>
                <span style={{ color: "#8b949e" }}>US SEMIS</span>
                <span style={{ color: "#39d353" }}>{b.advancers}↑</span>
                <span style={{ color: "#f85149" }}>{b.decliners}↓</span>
                <span style={{ color: "#8b949e" }}>/ {total}</span>
              </span>
            );
          })()}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#39d353" }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#39d353", animation: "pulse 2s infinite" }} />
            LIVE
          </div>
        </div>
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "138px 1fr", minHeight: "calc(100vh - 49px)" }}>
        {/* Watchlist */}
        <div style={{ borderRight: "1px solid #21262d", background: "#0d1117", overflowY: "auto", maxHeight: "calc(100vh - 49px)" }}>
          <div style={{ padding: "6px 6px", borderBottom: "1px solid #21262d", position: "relative" }}>
            <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1, marginBottom: 4 }}>WATCHLIST</div>
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
              const sig: "BUY" | "SELL" | "HOLD" =
                watchlistMacdSignals[sym] ?? (d.length ? getMacdMomentumSignal(d).signal : "HOLD");
              const sigC = sig === "BUY" ? "#39d353" : sig === "SELL" ? "#f85149" : "#e3b341";
              const vwap = watchlistVwap[sym];
              const lq = live[sym];
              const liveChg = lq ? lq.changePercent : chg;
              const livePrice = lq ? lq.price : l?.close;
              const liveChgAbs = lq ? lq.change : (l && p ? l.close - p.close : 0);
              const si = shorts[sym];
              const siPct = si?.shortPercentOfFloat ?? null;
              const siColor =
                si?.risk === "EXTREME" ? "#f85149"
                : si?.risk === "HIGH" ? "#ff7b29"
                : si?.risk === "MODERATE" ? "#e3b341"
                : si?.risk === "LOW" ? "#39d353"
                : "#484f58";
              return (
                <div key={sym} className="stock-row" onClick={() => onWatchlistRowClick(sym)}
                  data-stock-row={sym}
                  title={reorderModeSym && reorderModeSym !== sym ? `Move ${reorderModeSym} here` : "Select stock"}
                  style={{
                    padding: "4px 5px",
                    borderBottom: "1px solid #161b22",
                    background:
                      reorderModeSym === sym
                        ? "#1f6feb33"
                        : reorderModeSym
                          ? "#0f1722"
                          : selectedStock === sym
                            ? "#161b22"
                            : "transparent",
                    borderLeft:
                      reorderModeSym === sym
                        ? "2px solid #d2a8ff"
                        : selectedStock === sym
                          ? "2px solid #58a6ff"
                          : "2px solid transparent",
                    opacity: reorderModeSym && reorderModeSym !== sym ? 0.96 : 1,
                    transition: "background 120ms",
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                    WebkitTapHighlightColor: "transparent",
                  }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ fontWeight: 600, fontSize: 11, display: "flex", alignItems: "center", gap: 4 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeStock(sym); }}
                        title="Remove"
                        style={{ background: "transparent", border: "none", color: "#6e7681", cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1, width: 12 }}
                      >✕</button>
                      {(() => {
                        const flow = flowSignals[sym];
                        if (!flow) return <span>{sym}</span>;
                        const cls = flow.kind === "BUY_SURGE" ? "flow-flash-buy" : "flow-flash-sell";
                        const tip = flow.kind === "BUY_SURGE"
                          ? `MASSIVE BUYING — ${flow.volRatio.toFixed(1)}× avg minute volume, +${flow.pricePct.toFixed(2)}% on the bar`
                          : `MASSIVE SELLING — ${flow.volRatio.toFixed(1)}× avg minute volume, ${flow.pricePct.toFixed(2)}% on the bar`;
                        return <span className={cls} title={tip}>{sym}</span>;
                      })()}
                      <span style={{ fontSize: 9, color: sigC, fontWeight: 800 }}>{sig}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                      {reorderModeSym && reorderModeSym !== sym ? (
                        <span
                          aria-hidden="true"
                          style={{
                            minWidth: 28,
                            textAlign: "center",
                            color: "#58a6ff",
                            fontSize: 14,
                            fontWeight: 700,
                          }}
                        >
                          ⊕
                        </span>
                      ) : null}
                      <button
                        type="button"
                        aria-label={reorderModeSym === sym ? "Cancel reorder" : "Reorder stock"}
                        title={reorderModeSym === sym ? "Cancel reorder" : "Tap, then tap destination row"}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => {
                          e.stopPropagation();
                          toggleReorderMode(sym);
                        }}
                        style={{
                          background: "#161b22", border: "1px solid #30363d", color: "#8b949e",
                          cursor: "pointer", padding: "6px 10px", fontSize: 14, lineHeight: 1,
                          borderRadius: 4, userSelect: "none", WebkitUserSelect: "none",
                          WebkitTouchCallout: "none", WebkitTapHighlightColor: "transparent",
                          touchAction: "manipulation",
                        }}
                      >{reorderModeSym === sym ? "✕" : "⋮⋮"}</button>
                    </div>
                  </div>
                  {stockNames[sym] && (
                    <div style={{ fontSize: 9, color: "#8b949e", marginTop: 1, marginLeft: 16, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                      {stockNames[sym]}
                    </div>
                  )}
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 1, fontSize: 9 }}>
                    <span style={{ color: "#8b949e" }}>
                      {livePrice != null ? `$${livePrice.toFixed(2)}` : <span style={{ opacity: 0.6 }}>Loading…</span>}
                    </span>
                    <span style={{ display: "flex", alignItems: "center", gap: 3 }}>
                      {siPct != null && (
                        <span
                          title={`Short interest: ${siPct.toFixed(1)}% of float · ${si?.risk}${si?.shortRatio ? ` · ${si.shortRatio.toFixed(1)}d to cover` : ""}`}
                          style={{ fontSize: 7, fontWeight: 700, color: siColor, border: `1px solid ${siColor}`, borderRadius: 2, padding: "0 3px" }}
                        >
                          S{siPct.toFixed(0)}%
                        </span>
                      )}
                      {livePrice != null ? (
                        <span style={{ color: liveChg >= 0 ? "#39d353" : "#f85149" }}>
                          {liveChg >= 0 ? "+" : ""}${Math.abs(liveChgAbs).toFixed(2)} ({liveChg >= 0 ? "+" : ""}{liveChg.toFixed(2)}%)
                        </span>
                      ) : (
                        <span style={{ color: "#484f58" }}>—</span>
                      )}
                    </span>
                  </div>
                  <div style={{ marginTop: 1, fontSize: 9, color: "#8b949e" }}>
                    VWAP{" "}
                    <span
                      title="Intraday volume-weighted average price"
                      style={{
                        color: vwap == null || livePrice == null
                          ? "#8b949e"
                          : livePrice >= vwap ? "#39d353" : "#f85149",
                        fontWeight: 600,
                      }}
                    >
                      {vwap != null ? `$${vwap.toFixed(2)}` : "—"}
                    </span>
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
        <div style={{ padding: "6px 10px", overflowY: "auto", maxHeight: "calc(100vh - 49px)" }}>
          {/* Stock header — ultra-tight single row */}
          {(() => {
            // Header shows the regular-session (4pm) close even during after-hours.
            // AH/overnight price still ticks live in the left watchlist column.
            const regClose = liveSel?.regularPrice ?? liveSel?.price ?? last.close;
            const headPrice = regClose;
            const headPrev = liveSel?.previousClose ?? prev.close ?? 0;
            const headChange = headPrev ? regClose - headPrev : change;
            const headChangePct = headPrev ? (headChange / headPrev) * 100 : changePct;
            const pink = "#ff4fa3";
            const dt = dayTrade.signal;
            const dtBg = dt === "BUY" ? "rgba(255,79,163,0.18)" : dt === "SELL" ? "rgba(255,79,163,0.10)" : "rgba(255,79,163,0.05)";
            const sess = liveSel?.session;
            const sessLabel = sess === "PRE" ? "PRE" : sess === "POST" ? "AH" : sess === "REGULAR" ? "LIVE" : sess === "OVERNIGHT" ? "24H" : sess ? "CLSD" : null;
            const sessColor = sess === "REGULAR" ? "#39d353" : sess === "PRE" ? "#58a6ff" : sess === "POST" ? "#d2a8ff" : sess === "OVERNIGHT" ? "#ff9b3d" : "#8b949e";
            const si = shorts[selectedStock];
            const pct = si?.shortPercentOfFloat;
            const siColor = si?.risk === "EXTREME" ? "#f85149" : si?.risk === "HIGH" ? "#ff7b29" : si?.risk === "MODERATE" ? "#e3b341" : si?.risk === "LOW" ? "#39d353" : "#8b949e";
            const fmtM = (n: number | null | undefined) => n == null ? "—" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n.toLocaleString();
            return (
              <>
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 6, marginBottom: 4 }}>
                  <span style={{ fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 18, color: "#e6edf3", lineHeight: 1 }}>{selectedStock}</span>
                  {headPrice != null ? (
                    <>
                      <span style={{ fontSize: 18, fontWeight: 700, color: "#e6edf3", lineHeight: 1 }}>${headPrice.toFixed(2)}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: headChange >= 0 ? "#39d353" : "#f85149", lineHeight: 1 }}>
                        {headChange >= 0 ? "▲" : "▼"}{headChange >= 0 ? "+" : ""}${Math.abs(headChange).toFixed(2)} ({headChangePct >= 0 ? "+" : ""}{headChangePct.toFixed(2)}%)
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#8b949e", lineHeight: 1 }} title={`Bid${liveSel?.bidSize != null ? ` × ${liveSel.bidSize}` : ""}`}>
                        BID <span style={{ color: "#f85149" }}>{liveSel?.bid != null && liveSel.bid > 0 ? `$${liveSel.bid.toFixed(2)}` : "—"}</span>
                      </span>
                      <span style={{ fontSize: 10, fontWeight: 700, color: "#8b949e", lineHeight: 1 }} title={`Ask${liveSel?.askSize != null ? ` × ${liveSel.askSize}` : ""}`}>
                        ASK <span style={{ color: "#39d353" }}>{liveSel?.ask != null && liveSel.ask > 0 ? `$${liveSel.ask.toFixed(2)}` : "—"}</span>
                      </span>
                      {asiaSemis?.avgChangePct != null && (() => {
                        const pct = asiaSemis.avgChangePct;
                        const up = pct >= 0;
                        const color = up ? "#39d353" : "#f85149";
                        const tip = (asiaSemis.components ?? [])
                          .map((c: { name: string; symbol: string; changePct: number | null }) =>
                            `${c.name} (${c.symbol}): ${c.changePct == null ? "—" : (c.changePct >= 0 ? "+" : "") + c.changePct.toFixed(2) + "%"}`)
                          .join("\n");
                        return (
                          <span
                            title={`Asia semiconductor sector daily move (avg of TSMC, Samsung, SK Hynix, Tokyo Electron, Advantest)\n\n${tip}`}
                            style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 11, fontWeight: 800, color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 6px", lineHeight: 1 }}>
                            <span style={{ color: "#8b949e", fontSize: 9, fontWeight: 800, letterSpacing: 0.5 }}>ASIA SEMIS</span>
                            {up ? "▲" : "▼"}{up ? "+" : ""}{pct.toFixed(2)}%
                          </span>
                        );
                      })()}
                    </>
                  ) : <span style={{ fontSize: 13, color: "#8b949e" }}>…</span>}
                  {sessLabel && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: sessColor, border: `1px solid ${sessColor}`, borderRadius: 3, padding: "1px 4px", lineHeight: 1 }}>● {sessLabel}</span>
                  )}
                  <span style={{ flex: 1 }} />
                  <span style={{ background: signalBg, border: `1px solid ${signalColor}`, borderRadius: 4, padding: "3px 8px", fontSize: 11, fontWeight: 800, color: signalColor, lineHeight: 1 }} title={`${signalFrameLabel} · ${liveMacdSignal.reason}`}>
                    MACD {signal}
                  </span>
                  <span
                    title={`Day-trade signal (${intradayInterval} / ${intradayRange}): ${dayTrade.reason}\nRSI7 ${dayTrade.rsi ?? "—"} · VWAP ${dayTrade.vwap ?? "—"} · EMA9/21 ${dayTrade.emaFast ?? "—"}/${dayTrade.emaSlow ?? "—"}`}
                    style={{ background: dtBg, border: `1.5px solid ${pink}`, borderRadius: 4, padding: "3px 8px", fontSize: 11, fontWeight: 900, color: pink, lineHeight: 1, boxShadow: dt !== "HOLD" ? `0 0 8px ${pink}55` : "none" }}>
                    ⚡ {dt}
                  </span>
                </div>
                {/* Mini stat strip */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 6, fontSize: 10, color: "#8b949e", lineHeight: 1.2 }}>
                  <span>RSI <span style={{ color: (last.rsi ?? 50) < 30 ? "#39d353" : (last.rsi ?? 50) > 70 ? "#f85149" : "#e6edf3", fontWeight: 700 }}>{last.rsi?.toFixed(1) ?? "—"}</span></span>
                  <span>MACD <span style={{ color: (last.macdHist ?? 0) > 0 ? "#39d353" : "#f85149", fontWeight: 700 }}>{last.macdHist?.toFixed(3) ?? "—"}</span></span>
                  <span>SMA9 <span style={{ color: "#79c0ff", fontWeight: 700 }}>${last.sma9?.toFixed(2) ?? "—"}</span></span>
                  <span style={{ display: "flex", gap: 10, flexBasis: "100%" }}>
                    <span
                      title={si ? `Short interest from FINRA semi-monthly report\nFloat: ${fmtM(si.floatShares)}\nShares short: ${fmtM(si.sharesShort)}\nShort % of float: ${pct?.toFixed(2) ?? "—"}%\nDays to cover: ${si.shortRatio?.toFixed(1) ?? "—"}\nRisk: ${si.risk}\nSource: FINRA via Yahoo Finance` : "Short interest data sourced from FINRA semi-monthly report (unavailable)"}
                      style={{ cursor: "help" }}>
                      SHORT/FLOAT <span style={{ color: siColor, fontWeight: 800 }}>{pct != null ? `${pct.toFixed(1)}%` : "—"}</span>
                      {si?.risk && si.risk !== "UNKNOWN" && <span style={{ color: siColor, fontSize: 8, marginLeft: 3 }}>{si.risk}</span>}
                      <span style={{ color: "#484f58", fontSize: 8, marginLeft: 4 }}>FINRA</span>
                    </span>
                    {si?.sharesOutstanding != null && (
                      <span title="Total shares outstanding">SHARES OUT <span style={{ color: "#e6edf3", fontWeight: 700 }}>{fmtM(si.sharesOutstanding)}</span></span>
                    )}
                    {last.volume != null && last.volume > 0 && (
                      <span title="Latest daily volume (shares traded)">VOL <span style={{ color: "#e6edf3", fontWeight: 700 }}>{fmtM(last.volume)}</span></span>
                    )}
                  </span>
                  {(liveSel?.dayHigh != null || liveSel?.dayLow != null) && (
                    <span style={{ display: "flex", gap: 10, flexBasis: "100%" }}>
                      {liveSel?.dayHigh != null && (
                        <span title="Today's high">DAY H <span style={{ color: "#39d353", fontWeight: 700 }}>${liveSel.dayHigh.toFixed(2)}</span></span>
                      )}
                      {liveSel?.dayLow != null && (
                        <span title="Today's low">DAY L <span style={{ color: "#f85149", fontWeight: 700 }}>${liveSel.dayLow.toFixed(2)}</span></span>
                      )}
                      {liveSel?.open != null && (
                        <span title="Today's regular-session open">OPEN <span style={{ color: "#e6edf3", fontWeight: 700 }}>${liveSel.open.toFixed(2)}</span></span>
                      )}
                    </span>
                  )}
                  {(liveSel?.fiftyTwoWeekHigh != null || liveSel?.fiftyTwoWeekLow != null) && (
                    <span style={{ display: "flex", gap: 10, flexBasis: "100%" }}>
                      {liveSel?.fiftyTwoWeekHigh != null && (
                        <span title="52-week high">52W H <span style={{ color: "#39d353", fontWeight: 700 }}>${liveSel.fiftyTwoWeekHigh.toFixed(2)}</span></span>
                      )}
                      {liveSel?.fiftyTwoWeekLow != null && (
                        <span title="52-week low">52W L <span style={{ color: "#f85149", fontWeight: 700 }}>${liveSel.fiftyTwoWeekLow.toFixed(2)}</span></span>
                      )}
                      {liveSel?.previousClose != null && (
                        <span title="Previous regular-session close">PREV CLOSE <span style={{ color: "#e6edf3", fontWeight: 700 }}>${liveSel.previousClose.toFixed(2)}</span></span>
                      )}
                    </span>
                  )}
                  {liveSel?.preMarketPrice != null && (
                    <span>Pre <span style={{ color: (liveSel.preMarketChangePercent ?? 0) >= 0 ? "#39d353" : "#f85149" }}>${liveSel.preMarketPrice.toFixed(2)}</span></span>
                  )}
                  {liveSel?.postMarketPrice != null && (
                    <span>AH <span style={{ color: (liveSel.postMarketChangePercent ?? 0) >= 0 ? "#39d353" : "#f85149" }}>${liveSel.postMarketPrice.toFixed(2)}</span></span>
                  )}
                  {liveSel?.overnightPrice != null && (
                    <span>24H <span style={{ color: (liveSel.overnightChangePercent ?? 0) >= 0 ? "#39d353" : "#f85149" }}>${liveSel.overnightPrice.toFixed(2)}</span></span>
                  )}
                </div>
              </>
            );
          })()}

          {/* Range */}
          <div style={{ display: "grid", gap: 4, marginBottom: 4 }}>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(["1D", "2D", "5D"] as const).map((r) => (
                <button key={r} onClick={() => { setChartMode("INTRADAY"); setIntradayRange(r); }}
                  style={{ background: chartMode === "INTRADAY" && intradayRange === r ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: chartMode === "INTRADAY" && intradayRange === r ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: mono }}>
                  {r}
                </button>
              ))}
              {[14, 30, 60, 90, 120].map(r => (
                <button key={r} onClick={() => { setChartMode("D"); setChartRange(r); }}
                  style={{ background: chartMode === "D" && chartRange === r ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: chartMode === "D" && chartRange === r ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: mono }}>
                  {r}D
                </button>
              ))}
            </div>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
              {(["1m", "5m", "15m"] as const).map((interval) => (
                <button key={interval} onClick={() => { setChartMode("INTRADAY"); setIntradayInterval(interval); }}
                  style={{ background: chartMode === "INTRADAY" && intradayInterval === interval ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: chartMode === "INTRADAY" && intradayInterval === interval ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: mono }}>
                  {interval}
                </button>
              ))}
            </div>
          </div>

          {/* Price chart */}
          <ChartCard title="PRICE · MOVING AVERAGES · BOLLINGER BANDS"
            legend={[{ label: "SMA9", color: "#79c0ff" }, { label: "SMA15", color: "#d2a8ff" }, { label: "SMA50", color: "#ffa657" }, { label: "BB Upper/Lower", color: "#30363d" }]}>
            <ResponsiveContainer width="100%" height={340}>
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
            <ResponsiveContainer width="100%" height={340}>
              <ComposedChart data={macdDisplayData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="date" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} />
                <YAxis
                  stroke="#8b949e"
                  fontSize={9}
                  width={45}
                  domain={([min, max]: [number, number]) => {
                    const m = Math.max(Math.abs(min), Math.abs(max)) || 0.1;
                    const z = m * 1.15;
                    return [-z, z];
                  }}
                />
                {/* Hidden right axis just for the volume overlay so it
                    doesn't squash the MACD scale. */}
                <YAxis yAxisId="vol" orientation="right" hide domain={[0, (dataMax: number) => dataMax * 2.2]} />
                <Tooltip content={<CustomTooltip />} />
                <ReferenceLine y={0} stroke="#30363d" />
                {/* Volume bars rendered first so MACD lines/histogram sit on top */}
                <Bar yAxisId="vol" dataKey="volume" fill="#c9d1d9" fillOpacity={0.35} stroke="#8b949e" strokeOpacity={0.4} name="Volume" isAnimationActive={false} />
                <Bar dataKey="macdHist" name="Histogram">
                  {macdDisplayData.map((d: Row, i: number) => (
                    <Cell key={i} fill={(d.macdHist ?? 0) >= 0 ? "#39d353" : "#f85149"} fillOpacity={0.7} />
                  ))}
                </Bar>
                <Line type="monotone" dataKey="macd" stroke="#79c0ff" strokeWidth={3} dot={false} name="MACD" />
                <Line type="monotone" dataKey="macdSignal" stroke="#f85149" strokeWidth={3} dot={false} name="Signal" />
              </ComposedChart>
            </ResponsiveContainer>
          </ChartCard>

          {/* Macro market-moving news (CNBC / MarketWatch / WSJ) */}
          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 1.5 }}>
                🌐 MACRO NEWS · NASDAQ / S&amp;P 500 / DOW
              </div>
              <span style={{ fontSize: 9, color: "#8b949e" }}>CNBC · MarketWatch · WSJ</span>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {(!macroNews || macroNews.items.length === 0) && (
                <div style={{ fontSize: 10, color: "#8b949e" }}>Loading market news…</div>
              )}
              {macroNews?.items.slice(0, 10).map((n, i) => (
                <a key={i} href={n.link} target="_blank" rel="noreferrer"
                  style={{ display: "flex", gap: 8, padding: "6px 8px", background: "#010409", borderRadius: 4, textDecoration: "none", color: "#e6edf3", fontSize: 11, lineHeight: 1.4, border: "1px solid #161b22" }}>
                  <span style={{ fontSize: 8, fontWeight: 700, color: "#ffa657", letterSpacing: 1, minWidth: 70, paddingTop: 2 }}>
                    {n.publisher.toUpperCase()}
                  </span>
                  <span style={{ flex: 1 }}>
                    {n.title}
                    <span style={{ display: "block", fontSize: 9, color: "#8b949e", marginTop: 2 }}>
                      {n.publishedAt ? new Date(n.publishedAt * 1000).toLocaleString() : ""}
                    </span>
                  </span>
                </a>
              ))}
            </div>
          </div>

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

        </div>
      </div>

      {/* Notification */}
      {notification && (
        <div style={{ position: "fixed", top: 70, right: 16, background: "#0d1117", border: "1px solid #39d353", borderRadius: 6, padding: "10px 14px", fontSize: 11, color: "#e6edf3", animation: "slideIn 0.3s", zIndex: 101, maxWidth: 320 }}>
          {notification.msg}
        </div>
      )}
    </div>
  );
}

function ChartCard({ title, legend, titleRight, children }: { title: string; legend?: { label: string; color: string }[]; titleRight?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: "6px 8px 4px", marginBottom: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4, flexWrap: "wrap", gap: 8 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <EstClock />
          <div style={{ fontSize: 10, color: "#8b949e", letterSpacing: 1.5 }}>{title}</div>
          {titleRight}
        </div>
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

function EstClock() {
  const [now, setNow] = useState<Date | null>(null);
  useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(id);
  }, []);
  const time = now ? now.toLocaleTimeString("en-US", {
    timeZone: "America/New_York",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }) : "--:--:--";
  return (
    <span
      title="Current Eastern Time"
      style={{
        fontSize: 10,
        fontWeight: 700,
        color: "#58a6ff",
        background: "#0d1117",
        border: "1px solid #21262d",
        borderRadius: 4,
        padding: "2px 6px",
        letterSpacing: 1,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {time} ET
    </span>
  );
}

