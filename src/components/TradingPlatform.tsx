import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useServerFn } from "@tanstack/react-start";
import {
  getQuotes, searchSymbols, getLiveQuotes, getNews, analyzeNewsSentiment,
  getIntraday, getIntradayBatch, fetchScreener,
  type Candle, type SymbolSearchResult, type LiveQuote, type NewsItem, type SentimentResult,
  type IntradayBar, type ScreenerRow,
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
import { fetchFastPulse, fetchMacroNews, fetchGlobalSemiIndex } from "@/lib/market-pulse.functions";
import type { QuoteSnap } from "@/lib/market-pulse.server";
import { fetchOptionsActivity } from "@/lib/options.functions";
import type { OptionsActivity } from "@/lib/options.server";
import {
  getSchwabAuthUrl,
  getSchwabQuotes,
  refreshSchwabToken,
  getSchwabPriceHistory,
  getSchwabFundamentals,
  getSchwabTopStrikes,
  type SchwabTokens,
  type SchwabQuote,
  type SchwabBar,
  type SchwabFundamental,
  type SchwabTopStrikes,
} from "@/lib/schwab.functions";
import { SCHWAB_TOKEN_KEY } from "@/routes/auth.schwab.callback";
import { fetchEconCalendar } from "@/lib/econ-calendar.functions";
import {
  getSharedSchwabQuotes,
  getSharedSchwabFundamentals,
  getSharedSchwabTopStrikes,
  getSharedSchwabPriceHistory,
} from "@/lib/schwab-shared.functions";
import { detectTrap, type TrapResult } from "@/lib/trap-indicator";
import { useAuthUser } from "@/hooks/useAuthUser";
import { useSubscription } from "@/hooks/useSubscription";
import { supabase } from "@/integrations/supabase/client";
import {
  Line, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  ReferenceLine, Area, ComposedChart, Bar, Cell, Scatter,
} from "recharts";
import { useQueryClient } from "@tanstack/react-query";

// ============= Candlestick shape =============
// Recharts' stacked-bar candle trick forces the YAxis to include 0, which
// squashes intraday candles into a thin sliver. Use a single Bar with
// dataKey="candleRange" = [low, high] and render the full candle (wick +
// body) via a custom shape — Recharts then derives the YAxis purely from
// the price range and the candle draws correctly.
function Candle(props: any) {
  const { x, y, width, height, payload } = props;
  if (!payload || !Number.isFinite(width) || !Number.isFinite(height)) return null;
  const { open, high, low, close } = payload;
  if (![open, high, low, close].every((v: number) => Number.isFinite(v))) return null;
  const range = high - low || 1;
  const cx = x + width / 2;
  const bodyTop = y + ((high - Math.max(open, close)) / range) * height;
  const bodyBottom = y + ((high - Math.min(open, close)) / range) * height;
  const bodyHeight = Math.max(2, bodyBottom - bodyTop);
  const bodyWidth = Math.max(4, Math.min(width * 0.86, 18));
  const bodyX = cx - bodyWidth / 2;
  const fill = close >= open ? "#39d353" : "#f85149";
  return (
    <g>
      <line x1={cx} x2={cx} y1={y} y2={y + height} stroke={fill} strokeWidth={2} strokeLinecap="round" />
      <rect x={bodyX} y={bodyTop} width={bodyWidth} height={bodyHeight} fill={fill} stroke={fill} rx={1} />
    </g>
  );
}

function getTightPriceDomain<T extends { low?: number; high?: number; close?: number }>(
  rows: T[],
  recentBars = rows.length,
): [number, number] | ["auto", "auto"] {
  if (!rows.length) return ["auto", "auto"];
  const sample = rows.slice(Math.max(0, rows.length - Math.max(8, recentBars)));
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of sample) {
    const low = d.low ?? d.close;
    const high = d.high ?? d.close;
    if (Number.isFinite(low)) lo = Math.min(lo, low!);
    if (Number.isFinite(high)) hi = Math.max(hi, high!);
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ["auto", "auto"];
  const last = sample[sample.length - 1]?.close ?? hi;
  const span = Math.max(hi - lo, Math.abs(last) * 0.001, 0.04);
  const pad = Math.max(span * 0.12, Math.abs(last) * 0.0006, 0.02);
  return [Math.floor((lo - pad) * 100) / 100, Math.ceil((hi + pad) * 100) / 100];
}

/**
 * Build a "nice" tick array for a price Y axis so increments are always
 * cents/dollars at a human-readable step (0.01, 0.05, 0.10, 0.25, 0.50,
 * 1, 2, 5, 10, 25, 50, 100, …). Recharts' auto-ticks can pick ugly
 * irrationals when the domain is tight; this enforces clean lines.
 */
function niceTicks(domain: [number, number] | ["auto", "auto"] | unknown, target = 6): number[] | undefined {
  if (!Array.isArray(domain)) return undefined;
  const [a, b] = domain as [unknown, unknown];
  if (typeof a !== "number" || typeof b !== "number") return undefined;
  const lo = a;
  const hi = b;
  const span = hi - lo;
  if (!(span > 0)) return undefined;
  const rawStep = span / target;
  const steps = [0.01, 0.02, 0.05, 0.10, 0.25, 0.50, 1, 2, 5, 10, 25, 50, 100, 250, 500];
  let step = steps[steps.length - 1];
  for (const s of steps) if (s >= rawStep) { step = s; break; }
  const start = Math.ceil(lo / step) * step;
  const out: number[] = [];
  for (let v = start; v <= hi + 1e-9 && out.length < 12; v += step) out.push(Math.round(v / 0.01) * 0.01);
  return out.length >= 2 ? out : undefined;
}

const PRICE_AXIS_WIDTH = 62;

function intervalSeconds(interval: "1m" | "2m" | "5m" | "15m") {
  return interval === "1m" ? 60 : interval === "2m" ? 120 : interval === "5m" ? 300 : 900;
}

function alignEpochToInterval(epochSec: number, interval: "1m" | "2m" | "5m" | "15m") {
  const step = intervalSeconds(interval);
  return Math.floor(epochSec / step) * step;
}

function roundQuote(value: number) {
  return value >= 1 ? Math.round(value * 100) / 100 : Math.round(value * 10_000) / 10_000;
}

function tightEstimatedBidAsk(mark: number) {
  const halfSpread = Math.max(0.01, Math.min(mark * 0.0005, 0.15));
  return { bid: roundQuote(Math.max(0.0001, mark - halfSpread)), ask: roundQuote(mark + halfSpread) };
}

function bidAskNearMark(mark: number | null | undefined, bid: number | null | undefined, ask: number | null | undefined) {
  if (mark == null || !Number.isFinite(mark) || mark <= 0) return { bid: undefined, ask: undefined, syntheticBidAsk: false };
  if (bid == null || ask == null || !Number.isFinite(bid) || !Number.isFinite(ask) || bid <= 0 || ask <= 0 || ask < bid) {
    return { ...tightEstimatedBidAsk(mark), syntheticBidAsk: true };
  }
  const spread = ask - bid;
  const mid = (ask + bid) / 2;
  // Never show stale/wild NBBO against the live header mark. This catches the
  // MRVL-style problem where BID/ASK came from old lots while the header ticked live.
  if (spread > Math.max(mark * 0.02, 0.08) || Math.abs(mid - mark) > Math.max(mark * 0.01, 0.05)) {
    return { ...tightEstimatedBidAsk(mark), syntheticBidAsk: true };
  }
  return { bid, ask, syntheticBidAsk: false };
}

function getVisiblePriceDomain(rows: any[]): [number, number] | ["auto", "auto"] {
  if (!rows.length) return ["auto", "auto"];
  const keys = ["open", "high", "low", "close", "sma9", "sma15", "sma20", "ema21", "bbUpper", "bbLower", "bullLabelY", "sellLabelY", "buyArrowY", "sellArrowY"];
  let lo = Infinity;
  let hi = -Infinity;
  for (const d of rows) {
    for (const key of keys) {
      const v = d[key];
      if (typeof v === "number" && Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
    if (Array.isArray(d.candleRange)) {
      for (const v of d.candleRange) if (typeof v === "number" && Number.isFinite(v)) {
        lo = Math.min(lo, v);
        hi = Math.max(hi, v);
      }
    }
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) return ["auto", "auto"];
  const lastClose = rows[rows.length - 1]?.close ?? hi;
  const span = Math.max(hi - lo, Math.abs(lastClose) * 0.0008, 0.03);
  const pad = Math.max(span * 0.08, Math.abs(lastClose) * 0.00025, 0.01);
  return [Math.floor((lo - pad) * 100) / 100, Math.ceil((hi + pad) * 100) / 100];
}

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
const POSITIONS_KEY = "bryantrade.positions.v1";

type Position = { shares: number; entry: number };

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
  const { tier, isActive: subActive } = useSubscription(user?.id);
  const isPro = tier === "pro" && subActive;
  const [stockNames, setStockNames] = useState<Record<string, string>>(STOCK_NAMES);
  const [positions, setPositions] = useState<Record<string, Position>>({});
  const [editingPos, setEditingPos] = useState<string | null>(null);
  const [posDraft, setPosDraft] = useState<{ shares: string; entry: string }>({ shares: "", entry: "" });
  const [selectedStock, setSelectedStock] = useState("MRVL");
  const [showDetail, setShowDetail] = useState(false);
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
  const [intradayRange, setIntradayRange] = useState<"1D" | "2D" | "5D" | "24H">("1D");
  const [intradayInterval, setIntradayInterval] = useState<"1m" | "2m" | "5m" | "15m">("1m");
  // User-tweakable zoom multiplier for chart bar width (pinch / +/- buttons).
  const [chartZoom, setChartZoom] = useState(1);
  const [pushPerm, setPushPerm] = useState<PushPermission>("default");
  const [pushBusy, setPushBusy] = useState(false);
  const lastPushSignal = useRef<Record<string, "BUY" | "SELL">>({});
  // Tracks the last big-move direction we alerted for, so we don't spam
  // notifications for the same symbol while it stays above the ±5% threshold.
  const lastBigMove = useRef<Record<string, "UP" | "DOWN" | null>>({});
  // Flow-surge dedupe: only fire one push per symbol per direction until it
  // falls back to neutral.
  const lastFlowSurge = useRef<Record<string, "BUY_SURGE" | "SELL_SURGE" | null>>({});
  const masterScrollRef = useRef<HTMLDivElement | null>(null);
  const flowScrollRef = useRef<HTMLDivElement | null>(null);
  const macdScrollRef = useRef<HTMLDivElement | null>(null);
  const live24hBarsRef = useRef<Record<string, IntradayBar[]>>({});
  const [masterVisibleRange, setMasterVisibleRange] = useState<[number, number] | null>(null);
  const [macdVisibleRange, setMacdVisibleRange] = useState<[number, number] | null>(null);
  const [liveClockTick, setLiveClockTick] = useState(0);

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
  useEffect(() => {
    const id = setInterval(() => setLiveClockTick((v) => (v + 1) % 1_000_000), 1000);
    return () => clearInterval(id);
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

  // Load/persist positions (shares + entry price) — localStorage only
  useEffect(() => {
    try {
      const raw = localStorage.getItem(POSITIONS_KEY);
      if (raw) {
        const parsed = JSON.parse(raw) as Record<string, Position>;
        if (parsed && typeof parsed === "object") setPositions(parsed);
      }
    } catch {}
  }, []);
  useEffect(() => {
    try { localStorage.setItem(POSITIONS_KEY, JSON.stringify(positions)); } catch {}
  }, [positions]);

  const fetchQuotes = useServerFn(getQuotes);
  const fetchSearch = useServerFn(searchSymbols);
  const fetchLive = useServerFn(getLiveQuotes);
  const fetchNews = useServerFn(getNews);
  const fetchSentiment = useServerFn(analyzeNewsSentiment);
  const fetchIntraday = useServerFn(getIntraday);
  const fetchIntradayBatch = useServerFn(getIntradayBatch);
  const fetchScreenerFn = useServerFn(fetchScreener);
  const queryClient = useQueryClient();
  const [showScreener, setShowScreener] = useState(false);
  const [screenerTab, setScreenerTab] = useState<"gainers" | "losers" | "actives">("gainers");
  const [countdown, setCountdown] = useState(15);
  const firePush = useServerFn(sendAlert);
  const fireTestPush = useServerFn(sendTestPush);
  const callSubscribe = useServerFn(subscribeToPush);
  const callUnsubscribe = useServerFn(unsubscribeFromPush);
  const fetchShort = useServerFn(getShortInterest);
  const fetchMacroNewsFn = useServerFn(fetchMacroNews);
  const fetchFastPulseFn = useServerFn(fetchFastPulse);
  const fetchGlobalSemiIndexFn = useServerFn(fetchGlobalSemiIndex);
  const fetchOptionsActivityFn = useServerFn(fetchOptionsActivity);

  // ============ Schwab real-time quotes ============
  const fetchSchwabAuthUrl = useServerFn(getSchwabAuthUrl);
  const fetchSchwabQuotes = useServerFn(getSchwabQuotes);
  const refreshSchwab = useServerFn(refreshSchwabToken);
  const [schwabTokens, setSchwabTokens] = useState<SchwabTokens | null>(null);
  const [schwabErr, setSchwabErr] = useState<string | null>(null);
  useEffect(() => {
    try {
      // Prefer localStorage (survives closing the OAuth tab); fall back to
      // sessionStorage for legacy sessions.
      const raw = localStorage.getItem(SCHWAB_TOKEN_KEY) || sessionStorage.getItem(SCHWAB_TOKEN_KEY);
      if (raw) setSchwabTokens(JSON.parse(raw) as SchwabTokens);
    } catch {}
  }, []);
  const persistTokens = useCallback((t: SchwabTokens) => {
    setSchwabTokens(t);
    try { localStorage.setItem(SCHWAB_TOKEN_KEY, JSON.stringify(t)); } catch {}
    try { sessionStorage.setItem(SCHWAB_TOKEN_KEY, JSON.stringify(t)); } catch {}
  }, []);
  const connectSchwab = useCallback(async () => {
    try {
      const redirectUri = `${window.location.origin}/auth/schwab/callback`;
      const { url } = await fetchSchwabAuthUrl({ data: { redirectUri } });
      window.location.href = url;
    } catch (e) {
      setSchwabErr(e instanceof Error ? e.message : String(e));
    }
  }, [fetchSchwabAuthUrl]);

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
    if (!isPro) {
      showNotif("Real-time push alerts require the Pro plan. Upgrade on the Pricing page.");
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
    if (!isPro) {
      showNotif("Real-time push alerts require the Pro plan.");
      return;
    }
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
    // v8 chart endpoint — refresh snapshot (day H/L, prev close, 6mo candles)
    // every 10s instead of every 60s so close-price / day range stay current.
    staleTime: 10_000,
    refetchInterval: 10_000,
    refetchIntervalInBackground: true,
  });

  // Live intraday prices — refresh every 1s
  const { data: liveQuotes } = useQuery({
    queryKey: ["live", watchlist],
    queryFn: () => fetchLive({ data: { symbols: watchlist } }),
    refetchInterval: 250,
    refetchIntervalInBackground: true,
    staleTime: 0,
    enabled: watchlist.length > 0,
  });
  const live = (liveQuotes as Record<string, LiveQuote> | undefined) ?? {};

  // Schwab real-time quotes for EVERY watchlist symbol (polls every 1s when connected).
  const { data: schwabQuoteData } = useQuery({
    queryKey: ["schwabQuotes", [...watchlist].sort().join(","), schwabTokens?.access_token ?? ""],
    queryFn: async () => {
      if (!schwabTokens?.access_token) return null;
      const syms = watchlist.length ? watchlist : [selectedStock];
      try {
        return await fetchSchwabQuotes({ data: { accessToken: schwabTokens.access_token, symbols: syms } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("schwab_unauthorized") && schwabTokens.refresh_token) {
          try {
            const fresh = await refreshSchwab({ data: { refreshToken: schwabTokens.refresh_token } });
            persistTokens(fresh);
            return await fetchSchwabQuotes({ data: { accessToken: fresh.access_token, symbols: syms } });
          } catch (re) {
            setSchwabErr(re instanceof Error ? re.message : String(re));
            return null;
          }
        }
        setSchwabErr(msg);
        return null;
      }
    },
    enabled: !!schwabTokens?.access_token && watchlist.length > 0,
    refetchInterval: 500,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  // Per-user only (kept around in case some legacy code references it directly).
  const schwabQuotesPerUser = (schwabQuoteData as Record<string, SchwabQuote> | null) ?? {};

  // ---- Schwab 24-hour intraday pricehistory ----
  // Only fires when the user has selected the new "24H" range button AND has
  // Schwab connected. Returns 2 calendar days of 1m candles with extended-hours
  // data so the chart shows true overnight tape for tradeable equities.
  const fetchSchwabHistory = useServerFn(getSchwabPriceHistory);
  const { data: schwabHistoryData } = useQuery({
    queryKey: ["schwabHistory", selectedStock, intradayInterval, schwabTokens?.access_token ?? ""],
    queryFn: async () => {
      if (!schwabTokens?.access_token) return null;
      const freq = intradayInterval === "1m" ? 1 : intradayInterval === "2m" ? 1 : intradayInterval === "5m" ? 5 : 15;
      try {
        return await fetchSchwabHistory({
          data: { accessToken: schwabTokens.access_token, symbol: selectedStock, minutes: freq as 1 | 5 | 10 | 15 | 30, days: 2 },
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("schwab_unauthorized") && schwabTokens.refresh_token) {
          try {
            const fresh = await refreshSchwab({ data: { refreshToken: schwabTokens.refresh_token } });
            persistTokens(fresh);
            return await fetchSchwabHistory({
              data: { accessToken: fresh.access_token, symbol: selectedStock, minutes: freq as 1 | 5 | 10 | 15 | 30, days: 2 },
            });
          } catch { return null; }
        }
        return null;
      }
    },
    enabled: !!schwabTokens?.access_token && intradayRange === "24H",
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  // ---- Schwab fundamentals (short interest / float) for all watchlist syms ----
  const fetchSchwabFundamentals = useServerFn(getSchwabFundamentals);
  const { data: schwabFundData } = useQuery({
    queryKey: ["schwabFundamentals", [...watchlist].sort().join(",")],
    queryFn: async () => {
      if (!schwabTokens?.access_token || watchlist.length === 0) return null;
      try {
        return await fetchSchwabFundamentals({ data: { accessToken: schwabTokens.access_token, symbols: watchlist } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("schwab_unauthorized") && schwabTokens.refresh_token) {
          try {
            const fresh = await refreshSchwab({ data: { refreshToken: schwabTokens.refresh_token } });
            persistTokens(fresh);
            return await fetchSchwabFundamentals({ data: { accessToken: fresh.access_token, symbols: watchlist } });
          } catch { return null; }
        }
        return null;
      }
    },
    enabled: !!schwabTokens?.access_token && watchlist.length > 0,
    refetchInterval: 10 * 60_000, // 10 min — fundamentals don't tick
    staleTime: 10 * 60_000,
  });
  const schwabFundamentalsPerUser = (schwabFundData as Record<string, SchwabFundamental> | null) ?? {};

  // ---- Schwab top-volume call/put strikes for the selected symbol ----
  // Daily-keyed so the strike target refreshes whenever the date rolls and
  // also rechecks every 60s to follow intraday flow.
  const fetchSchwabStrikes = useServerFn(getSchwabTopStrikes);
  const todayKey = new Date().toISOString().slice(0, 10);
  const { data: schwabStrikesData } = useQuery({
    queryKey: ["schwabStrikes", selectedStock, todayKey],
    queryFn: async () => {
      if (!schwabTokens?.access_token) return null;
      try {
        return await fetchSchwabStrikes({ data: { accessToken: schwabTokens.access_token, symbol: selectedStock } });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (msg.includes("schwab_unauthorized") && schwabTokens.refresh_token) {
          try {
            const fresh = await refreshSchwab({ data: { refreshToken: schwabTokens.refresh_token } });
            persistTokens(fresh);
            return await fetchSchwabStrikes({ data: { accessToken: fresh.access_token, symbol: selectedStock } });
          } catch { return null; }
        }
        return null;
      }
    },
    enabled: !!schwabTokens?.access_token && !!selectedStock,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const schwabTopStrikesPerUser = (schwabStrikesData as SchwabTopStrikes | null) ?? null;

  // ============================================================
  // SHARED SCHWAB FEED
  // Runs for EVERY visitor (including shared/published-link viewers who
  // are not signed into Schwab). Uses the project owner's Schwab token
  // stored server-side. If the owner hasn't connected Schwab yet these
  // server fns return null and the UI falls back to Yahoo as before.
  // ============================================================
  const fetchSharedQuotes = useServerFn(getSharedSchwabQuotes);
  const { data: sharedQuoteData } = useQuery({
    queryKey: ["sharedSchwabQuotes", [...watchlist].sort().join(",")],
    queryFn: () => fetchSharedQuotes({ data: { symbols: watchlist.length ? watchlist : [selectedStock] } }),
    enabled: watchlist.length > 0,
    refetchInterval: 500,
    refetchIntervalInBackground: true,
    staleTime: 0,
  });
  const fetchSharedFund = useServerFn(getSharedSchwabFundamentals);
  const { data: sharedFundData } = useQuery({
    queryKey: ["sharedSchwabFundamentals", [...watchlist].sort().join(",")],
    queryFn: () => fetchSharedFund({ data: { symbols: watchlist } }),
    enabled: watchlist.length > 0,
    refetchInterval: 10 * 60_000,
    staleTime: 10 * 60_000,
  });
  const fetchSharedStrikes = useServerFn(getSharedSchwabTopStrikes);
  const sharedStrikesTodayKey = new Date().toISOString().slice(0, 10);
  const { data: sharedStrikesData } = useQuery({
    queryKey: ["sharedSchwabStrikes", selectedStock, sharedStrikesTodayKey],
    queryFn: () => fetchSharedStrikes({ data: { symbol: selectedStock } }),
    enabled: !!selectedStock,
    refetchInterval: 60_000,
    staleTime: 30_000,
  });
  const fetchSharedHistory = useServerFn(getSharedSchwabPriceHistory);
  const { data: sharedHistoryData } = useQuery({
    queryKey: ["sharedSchwabHistory", selectedStock, intradayInterval],
    queryFn: () => {
      const freq = intradayInterval === "1m" ? 1 : intradayInterval === "2m" ? 1 : intradayInterval === "5m" ? 5 : 15;
      return fetchSharedHistory({ data: { symbol: selectedStock, minutes: freq as 1 | 5 | 10 | 15 | 30, days: 2 } });
    },
    enabled: intradayRange === "24H" && !schwabTokens?.access_token,
    refetchInterval: 15_000,
    staleTime: 5_000,
  });

  // Merge per-user (preferred) with shared (fallback) so signed-out viewers
  // still see live Schwab quotes via the owner's account.
  const mergedSchwabQuotes: Record<string, SchwabQuote> = useMemo(() => {
    const shared = (sharedQuoteData as Record<string, SchwabQuote> | null) ?? {};
    return { ...shared, ...((schwabQuoteData as Record<string, SchwabQuote> | null) ?? {}) };
  }, [sharedQuoteData, schwabQuoteData]);
  const mergedSchwabFund: Record<string, SchwabFundamental> = useMemo(() => {
    const shared = (sharedFundData as Record<string, SchwabFundamental> | null) ?? {};
    return { ...shared, ...((schwabFundData as Record<string, SchwabFundamental> | null) ?? {}) };
  }, [sharedFundData, schwabFundData]);
  const mergedSchwabStrikes: SchwabTopStrikes | null =
    (schwabStrikesData as SchwabTopStrikes | null) ?? (sharedStrikesData as SchwabTopStrikes | null) ?? null;

  // Public aliases the rest of the component already uses. Now backed by the
  // merged feed so shared/published-link viewers see the same live data.
  const schwabQuotes = mergedSchwabQuotes;
  const schwabQuote: SchwabQuote | null = mergedSchwabQuotes[selectedStock] ?? null;
  const schwabFundamentals = mergedSchwabFund;
  const schwabTopStrikes = mergedSchwabStrikes;
  const liveBase = live[selectedStock];
  const selectedMark = schwabQuote?.last ?? liveBase?.price;
  const selectedSchwabNbbo = bidAskNearMark(selectedMark, schwabQuote?.bid, schwabQuote?.ask);
  const selectedNbbo = selectedSchwabNbbo.syntheticBidAsk
    ? bidAskNearMark(selectedMark, liveBase?.bid, liveBase?.ask)
    : selectedSchwabNbbo;
  const selectedLiveQuote = schwabQuote?.last != null
    ? {
        ...(liveBase ?? { symbol: selectedStock, ts: Date.now() } as any),
        price: schwabQuote.last,
        bid: selectedNbbo.bid,
        ask: selectedNbbo.ask,
        bidSize: schwabQuote.bidSize ?? liveBase?.bidSize,
        askSize: schwabQuote.askSize ?? liveBase?.askSize,
        syntheticBidAsk: selectedNbbo.syntheticBidAsk,
      }
    : liveBase
      ? { ...liveBase, ...selectedNbbo }
      : liveBase;

  // Bid/ask now comes through getLiveQuotes (v7 endpoint returns bid/ask/bidSize/askSize)
  // on the same 1s tick as the live price — no separate query.

  // Screener — gainers / losers / most active, refresh every 15s.
  const { data: screenerData, isFetching: screenerFetching, dataUpdatedAt: screenerUpdatedAt } = useQuery({
    queryKey: ["screener"],
    queryFn: () => fetchScreenerFn(),
    refetchInterval: 15_000,
    staleTime: 12_000,
    enabled: showScreener,
  });
  useEffect(() => {
    if (!showScreener) return;
    const id = setInterval(() => setCountdown((c) => (c <= 1 ? 15 : c - 1)), 1000);
    return () => clearInterval(id);
  }, [showScreener]);
  useEffect(() => { setCountdown(15); }, [screenerUpdatedAt]);

  // Short interest / float — refresh every 30 min (Yahoo updates twice a month)
  const { data: shortData } = useQuery({
    queryKey: ["short", watchlist],
    queryFn: () => fetchShort({ data: { symbols: watchlist } }),
    staleTime: 30 * 60_000,
    refetchInterval: 30 * 60_000,
    enabled: watchlist.length > 0,
  });
  const shorts = (shortData as Record<string, ShortInterest> | undefined) ?? {};

  // Global semiconductor index tracker — 6 major indices, 15s refresh
  const { data: globalSemis } = useQuery({
    queryKey: ["globalSemis"],
    queryFn: () => fetchGlobalSemiIndexFn(),
    staleTime: 12_000,
    refetchInterval: 15_000,
    refetchIntervalInBackground: true,
  });

  // SEMI RISK is now derived from the Asian/Philly semiconductor indices
  // (globalSemis, above). Headline-sentiment query removed.

  // Macro market-moving news (CNBC / MarketWatch / WSJ) — refresh every 5 minutes.
  const { data: macroNews } = useQuery({
    queryKey: ["macroNews"],
    queryFn: () => fetchMacroNewsFn(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
  });

  // Economic calendar — Fed / BLS / BEA / Treasury releases. Refresh every
  // 5 min; drives the yellow 'E' markers on the Master chart.
  const fetchEconCal = useServerFn(fetchEconCalendar);
  const { data: econData } = useQuery({
    queryKey: ["econCalendar"],
    queryFn: () => fetchEconCal(),
    staleTime: 5 * 60_000,
    refetchInterval: 5 * 60_000,
    refetchIntervalInBackground: true,
  });
  const econItems = econData?.items ?? [];

  // Split market pulse into two lanes so each can refresh at max safe speed:
  //   • fastPulse  = futures (ES/NQ/YM/RTY) + VIX  → 5 symbols → 2s
  //   • semisPulse = SOXX + SMH + 12-name basket + risk gauge → 15 symbols → 3s
  // The per-symbol quote stream still runs at 1s and the watchlist intraday
  // batch at 3s — those drive the flash alerts.
  const { data: fastPulse } = useQuery({
    queryKey: ["fastPulse"],
    queryFn: () => fetchFastPulseFn(),
    staleTime: 0,
    refetchInterval: 1_000,
    refetchIntervalInBackground: true,
  });
  const marketPulse = useMemo(() => {
    if (!fastPulse) return undefined;
    return {
      futures: fastPulse?.futures ?? [],
      vix: fastPulse?.vix ?? null,
    };
  }, [fastPulse]);

  // Futures momentum tracker — flash only when there's directional momentum
  // over the last ~10s, not just because the day's change is +/-. Keeps a
  // rolling 30s sample buffer per symbol and computes short-window slope.
  const futuresHistoryRef = useRef<Record<string, Array<{ t: number; p: number }>>>({});
  const [futuresMomentum, setFuturesMomentum] = useState<Record<string, "BUY" | "SELL" | null>>({});
  useEffect(() => {
    if (!fastPulse?.futures?.length) return;
    const now = Date.now();
    const hist = futuresHistoryRef.current;
    const next: Record<string, "BUY" | "SELL" | null> = {};
    for (const f of fastPulse.futures) {
      if (f.price == null) { next[f.symbol] = null; continue; }
      const arr = hist[f.symbol] ?? (hist[f.symbol] = []);
      arr.push({ t: now, p: f.price });
      // Keep last 30s
      while (arr.length && now - arr[0].t > 30_000) arr.shift();
      // Compare to the oldest sample within ~10s window (need >=4s of data)
      const window = arr.filter((s) => now - s.t <= 10_000);
      if (window.length < 2 || now - window[0].t < 4_000) { next[f.symbol] = null; continue; }
      const base = window[0].p;
      const deltaPct = ((f.price - base) / base) * 100;
      // ~0.03% over 10s ≈ meaningful intraday futures momentum
      if (deltaPct >= 0.03) next[f.symbol] = "BUY";
      else if (deltaPct <= -0.03) next[f.symbol] = "SELL";
      else next[f.symbol] = null;
    }
    setFuturesMomentum((prev) => {
      // Avoid re-render if unchanged
      const keys = Object.keys(next);
      if (keys.every((k) => prev[k] === next[k]) && Object.keys(prev).length === keys.length) return prev;
      return next;
    });
  }, [fastPulse]);

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
      range: (intradayRange === "24H" ? "2d" : intradayRange.toLowerCase()) as "1d" | "2d" | "5d",
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
  // For 24H mode prefer Schwab's true 2-day extended-hours candles; falls back
  // to Yahoo when Schwab isn't connected (the 2d range covers the prior
  // overnight session well enough for a synthetic 24h view).
  const intradayBars: IntradayBar[] = useMemo(() => {
    if (intradayRange === "24H") {
      const sb = (schwabHistoryData as SchwabBar[] | null) ?? null;
      if (sb && sb.length) return sb;
      const shared = (sharedHistoryData as SchwabBar[] | null) ?? null;
      if (shared && shared.length) return shared;
    }
    return intradayData ?? [];
  }, [intradayRange, schwabHistoryData, sharedHistoryData, intradayData]);
  const stitchedIntradayBars: IntradayBar[] = useMemo(() => {
    if (intradayRange !== "24H") return intradayBars;
    const merged = new Map<number, IntradayBar>();
    for (const b of intradayBars) {
      if (Number.isFinite(b?.t) && Number.isFinite(b?.close)) merged.set(b.t, b);
    }
    for (const b of intradayData ?? []) {
      if (!Number.isFinite(b?.t) || !Number.isFinite(b?.close)) continue;
      if (!merged.has(b.t)) merged.set(b.t, b);
    }
    const liveRows = live24hBarsRef.current[selectedStock] ?? [];
    for (const b of liveRows) {
      if (Number.isFinite(b?.t) && Number.isFinite(b?.close) && !merged.has(b.t)) merged.set(b.t, b);
    }
    const rows = [...merged.values()].sort((a, b) => a.t - b.t);
    const livePrice = selectedLiveQuote?.price;
    if (typeof livePrice === "number" && Number.isFinite(livePrice) && livePrice > 0) {
      const nowSec = alignEpochToInterval(Math.floor(Date.now() / 1000), intradayInterval);
      const last = rows[rows.length - 1];
      const maxGap = intervalSeconds(intradayInterval) * 2.5;
      if (!last || nowSec - last.t > maxGap) {
        const tickBar = { t: nowSec, open: livePrice, high: livePrice, low: livePrice, close: livePrice, volume: 0 };
        rows.push(tickBar);
        live24hBarsRef.current[selectedStock] = [...liveRows.filter((b) => Date.now() / 1000 - b.t < 24 * 60 * 60), tickBar];
      } else {
        const tickBar = {
          ...last,
          close: livePrice,
          high: Math.max(last.high, livePrice),
          low: Math.min(last.low, livePrice),
        };
        rows[rows.length - 1] = tickBar;
        live24hBarsRef.current[selectedStock] = [...liveRows.filter((b) => b.t !== tickBar.t && Date.now() / 1000 - b.t < 24 * 60 * 60), tickBar];
      }
    }
    const cutoff = Math.floor(Date.now() / 1000) - 24 * 60 * 60;
    return rows.filter((b) => b.t >= cutoff);
  }, [intradayRange, intradayBars, intradayData, selectedLiveQuote?.price, intradayInterval, selectedStock, liveClockTick]);
  const dayTrade = useMemo(() => getDayTradeSignal(stitchedIntradayBars), [stitchedIntradayBars]);

  // ----- Gap-and-Trap indicator for the selected symbol -----
  const trap: TrapResult = useMemo(
    () => detectTrap(stitchedIntradayBars as unknown as Parameters<typeof detectTrap>[0], schwabQuote?.vwap ?? null),
    [stitchedIntradayBars, schwabQuote?.vwap],
  );

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

  // Unusual options activity — every watchlist name, refresh every 10s.
  // Calls/puts volume from Nasdaq's option chain. Used to colour each ticker
  // (green = bullish call flow, red = bearish put flow). Chunked in batches
  // of 20 on the server to keep latency low.
  const { data: optionsActivityData } = useQuery({
    queryKey: ["optionsActivity", [...watchlist].sort().join(",")],
    queryFn: async () => {
      const all = [...watchlist];
      const chunks: string[][] = [];
      for (let i = 0; i < all.length; i += 20) chunks.push(all.slice(i, i + 20));
      const results = await Promise.all(
        chunks.map((c) => fetchOptionsActivityFn({ data: { symbols: c } })),
      );
      const items: Record<string, OptionsActivity> = {};
      for (const r of results) Object.assign(items, r?.items ?? {});
      return { items, asOf: Date.now() };
    },
    refetchInterval: 2_000,
    refetchIntervalInBackground: true,
    staleTime: 8_000,
    enabled: watchlist.length > 0,
  });
  const optionsActivity = (optionsActivityData?.items ?? {}) as Record<string, OptionsActivity>;
  const { data: selectedOptionsActivity } = useQuery({
    queryKey: ["selectedOptionsActivity", selectedStock],
    queryFn: () => fetchOptionsActivityFn({ data: { symbols: [selectedStock] } }),
    refetchInterval: 2_000,
    refetchIntervalInBackground: true,
    staleTime: 0,
    enabled: !!selectedStock,
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
    const lqBase = live[sym];
    // Prefer Schwab real-time NBBO for EVERY symbol when connected.
    const sq = schwabQuotes[sym];
    const mark = sq?.last ?? lqBase?.price;
    const schwabNbbo = bidAskNearMark(mark, sq?.bid, sq?.ask);
    const nbbo = schwabNbbo.syntheticBidAsk
      ? bidAskNearMark(mark, lqBase?.bid, lqBase?.ask)
      : schwabNbbo;
    const lq = sq?.last != null
      ? {
          ...(lqBase ?? { symbol: sym, price: sq.last, ts: Date.now() } as any),
          price: sq.last,
          bid: nbbo.bid,
          ask: nbbo.ask,
          bidSize: sq.bidSize ?? lqBase?.bidSize,
          askSize: sq.askSize ?? lqBase?.askSize,
          syntheticBidAsk: nbbo.syntheticBidAsk,
        }
      : lqBase
        ? { ...lqBase, ...nbbo }
        : lqBase;
    // Also write back into the live map so all other UI (bid/ask, VWAP comparisons) sees Schwab.
    if (lq && lq !== lqBase) (live as any)[sym] = lq;
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
    const bars = stitchedIntradayBars;
    if (!bars.length) return [];
    const rows: Row[] = bars.map((b) => ({
      date: intradayRange === "1D"
        ? new Date(b.t * 1000).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", hour12: false })
        : new Date(b.t * 1000).toLocaleString([], { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }),
      close: b.close, open: b.open, high: b.high, low: b.low, volume: b.volume,
    }));
    const livePrice = selectedLiveQuote?.price;
    if (typeof livePrice === "number" && Number.isFinite(livePrice) && rows.length) {
      const lastBar = { ...rows[rows.length - 1] };
      lastBar.close = livePrice;
      lastBar.high = Math.max(lastBar.high, livePrice);
      lastBar.low = Math.min(lastBar.low, livePrice);
      rows[rows.length - 1] = lastBar;
    }
    return buildChartData(rows);
  }, [stitchedIntradayBars, intradayRange, selectedLiveQuote?.price]);

  const chartData = chartMode === "D" ? dailyChartData : intradayRows;
  // Keep the full selected timeframe. Readability comes from thick candles +
  // auto-scrolling to the latest market time, not from slicing away bars.
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
  const macdDisplayData = displayData;
  // Candlestick-ready data: only last 6 arrow signals (3 BUY + 3 SELL) annotated,
  // plus EMA21 (EMA9 already on Row) for the top panel.
  const macdCandleData = useMemo(() => {
    const src = macdDisplayData as Row[];
    if (!src.length) return [] as Array<Row & {
      candleStart: number; candleBody: number; candleColor: string;
      wickStart: number; wickRange: number;
      candleRange: [number, number];
      buyArrowY: number | null; sellArrowY: number | null;
      ema21: number;
      vwap: number | null; vwapUpper: number | null; vwapLower: number | null;
      cumDelta: number; deltaBar: number;
    }>;
    const kEma21 = 2 / 22;
    let ema21 = src[0].close;
    // Count BUY/SELL from most recent backwards, allow only last 3 each
    let buyKept = 0, sellKept = 0;
    const keepBuy = new Set<number>();
    const keepSell = new Set<number>();
    for (let i = src.length - 1; i >= 0; i--) {
      if (src[i].macdAlert === "BUY" && buyKept < 3) { keepBuy.add(i); buyKept++; }
      else if (src[i].macdAlert === "SELL" && sellKept < 3) { keepSell.add(i); sellKept++; }
    }
    // Session-anchored VWAP (resets per calendar day) + rolling ±1σ VWAP bands.
    // Cumulative Delta = signed volume, sign = candle direction (proxy for
    // aggressor volume when true tick data isn't available).
    let cumTPV = 0, cumV = 0, cumTPV2 = 0;
    let cumDelta = 0;
    let currentDay = "";
    // Chart rows carry display-formatted date strings, not ISO timestamps:
    //   1D intraday   -> "HH:MM"        (single session)
    //   multi-day     -> "M/D, HH:MM"   (group by "M/D")
    //   daily (D)     -> "M/D" or ISO   (accumulate across the whole window
    //                                    so anchored VWAP + bands + cum-delta
    //                                    remain meaningful instead of resetting
    //                                    every single bar)
    const getDay = (raw: any): string => {
      // Daily view: anchor across the full displayed window so anchored VWAP,
      // ±1σ bands, and cumulative delta actually build up across bars.
      if (chartMode === "D") return "D-WINDOW";
      const s = String(raw?.date ?? "");
      if (/^\d{1,2}:\d{2}$/.test(s)) return "1D-SESSION";
      const md = s.match(/^(\d{1,2}\/\d{1,2})/);
      if (md) return md[1];
      const dt = new Date(s);
      if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(0, 10);
      return "ALL";
    };
    const out = src.map((d, i) => {
      const o = (d as any).open ?? d.close;
      const h = (d as any).high ?? d.close;
      const l = (d as any).low ?? d.close;
      const body = Math.abs(d.close - o);
      const start = Math.min(o, d.close);
      const green = d.close >= o;
      if (i === 0) ema21 = d.close;
      else ema21 = d.close * kEma21 + ema21 * (1 - kEma21);
      const offset = Math.max((h - l) * 0.015, d.close * 0.00005, 0.005);
      const day = getDay(d);
      if (day !== currentDay) {
        currentDay = day; cumTPV = 0; cumV = 0; cumTPV2 = 0; cumDelta = 0;
      }
      const tp = (h + l + d.close) / 3;
      const v = d.volume ?? 0;
      cumTPV += tp * v;
      cumV += v;
      cumTPV2 += tp * tp * v;
      const vwap = cumV > 0 ? cumTPV / cumV : null;
      const variance = cumV > 0 ? Math.max(0, cumTPV2 / cumV - (vwap as number) * (vwap as number)) : 0;
      const sigma = Math.sqrt(variance);
      const vwapUpper = vwap != null ? vwap + sigma : null;
      const vwapLower = vwap != null ? vwap - sigma : null;
      const deltaBar = (green ? 1 : -1) * v;
      cumDelta += deltaBar;
      return {
        ...d,
        candleStart: +start.toFixed(4),
        candleBody: +body.toFixed(4),
        candleColor: green ? "#39d353" : "#f85149",
        wickStart: +l.toFixed(4),
        wickRange: +(h - l).toFixed(4),
        // Single-shape candle uses [low, high] range
        candleRange: [+l.toFixed(4), +h.toFixed(4)] as [number, number],
        open: o, high: h, low: l,
        buyArrowY: keepBuy.has(i) ? +(l - offset).toFixed(4) : null,
        sellArrowY: keepSell.has(i) ? +(h + offset).toFixed(4) : null,
        ema21: +ema21.toFixed(4),
        vwap: vwap != null ? +vwap.toFixed(4) : null,
        vwapUpper: vwapUpper != null ? +vwapUpper.toFixed(4) : null,
        vwapLower: vwapLower != null ? +vwapLower.toFixed(4) : null,
        cumDelta: +cumDelta.toFixed(0),
        deltaBar: +deltaBar.toFixed(0),
      };
    });
    return out;
  }, [macdDisplayData, chartMode]);
  const last = chartData[chartData.length - 1] || ({} as Row);
  const prev = chartData[chartData.length - 2] || ({} as Row);
  const liveSel = selectedLiveQuote;
  const change = liveSel ? liveSel.change : (last.close && prev.close ? last.close - prev.close : 0);
  const changePct = liveSel ? liveSel.changePercent : (prev.close ? (change / prev.close) * 100 : 0);
  const signal = liveMacdSignal.signal;
  const signalFrameLabel = selectedLiveMacdRows.length >= 5 ? "MACD live · 3s refresh" : "MACD daily fallback";

  // OBV + MFI(14) per bar — for the flow chart
  const flowChartData = useMemo(() => {
    if (!displayData.length) return [] as Array<Row & { obv: number; obvPlot: number; mfi: number | null; tp: number }>;
    const tps = displayData.map((d) => (((d as any).high ?? d.close) + ((d as any).low ?? d.close) + d.close) / 3);
    let obv = 0;
    const out: Array<Row & { obv: number; mfi: number | null; tp: number }> = [];
    for (let i = 0; i < displayData.length; i++) {
      const d = displayData[i];
      if (i > 0) {
        if (d.close > displayData[i - 1].close) obv += d.volume ?? 0;
        else if (d.close < displayData[i - 1].close) obv -= d.volume ?? 0;
      }
      let mfi: number | null = null;
      if (i >= 14) {
        let pos = 0, neg = 0;
        for (let j = i - 13; j <= i; j++) {
          if (j === 0) continue;
          const rmf = tps[j] * (displayData[j].volume ?? 0);
          if (tps[j] > tps[j - 1]) pos += rmf;
          else if (tps[j] < tps[j - 1]) neg += rmf;
        }
        const ratio = neg === 0 ? 100 : pos / neg;
        mfi = +(100 - 100 / (1 + ratio)).toFixed(2);
      }
      out.push({ ...d, obv: +obv.toFixed(0), mfi, tp: +tps[i].toFixed(2) });
    }
    const anchor = out[Math.max(0, out.length - 40)]?.obv ?? 0;
    return out.map((d) => ({ ...d, obvPlot: d.obv - anchor }));
  }, [displayData]);

  // Price chart data follows the selected timeframe buttons and adds
  // OV-style signal labels on top of real OHLC candles.
  type MasterRow = {
    date: string;
    open: number; high: number; low: number; close: number; volume: number;
    candleStart: number; candleBody: number; candleColor: string;
    wickStart: number; wickRange: number;
    candleRange: [number, number];
    sma20: number | null; sma200: number | null; sma9: number | null; sma15: number | null;
    bbUpper: number | null; bbMiddle: number | null; bbLower: number | null;
    bullLabelY: number | null;     // shows "BULL" below the bar
    sellLabelY: number | null;     // shows "SELL" above the bar
    bottomingTailY: number | null; // small ▲
    toppingTailY: number | null;   // small ▼
    isElephant: boolean;
    newsMarkerY: number | null;
    newsCount: number;
    econMarkerY: number | null;
    econCount: number;
    econCat: string | null;
  };
  const masterData = useMemo<MasterRow[]>(() => {
    if (!displayData.length) return [];
    const bars = displayData;
    const closes = bars.map((b) => b.close);
    // Map news headlines to bar indices so we can drop 📰 markers on the
    // candle the news landed on. Only valid for intraday mode (where bars[i]
    // aligns with stitchedIntradayBars[i]); daily mode skips.
    const newsBarMap = new Map<number, number>(); // idx -> count
    if (chartMode !== "D" && stitchedIntradayBars.length === bars.length && newsItems.length) {
      const ts = stitchedIntradayBars.map((b) => b.t);
      const stepSec = ts.length >= 2 ? Math.max(60, ts[ts.length - 1] - ts[ts.length - 2]) : 120;
      for (const n of newsItems) {
        const p = n.publishedAt;
        if (!p) continue;
        // Binary search for nearest bar.
        let lo = 0, hi = ts.length - 1, best = -1, bestDiff = Infinity;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const d = Math.abs(ts[mid] - p);
          if (d < bestDiff) { bestDiff = d; best = mid; }
          if (ts[mid] < p) lo = mid + 1; else hi = mid - 1;
        }
        if (best >= 0 && bestDiff <= stepSec * 2) {
          newsBarMap.set(best, (newsBarMap.get(best) ?? 0) + 1);
        }
      }
    }
    // Econ event markers 'E' (Fed / BLS / BEA / Treasury) — same mapping.
    const econBarMap = new Map<number, { count: number; cat: string }>();
    if (chartMode !== "D" && stitchedIntradayBars.length === bars.length && econItems.length) {
      const ts = stitchedIntradayBars.map((b) => b.t);
      const stepSec = ts.length >= 2 ? Math.max(60, ts[ts.length - 1] - ts[ts.length - 2]) : 120;
      const winStart = ts[0], winEnd = ts[ts.length - 1];
      for (const e of econItems) {
        if (!e.publishedAt || e.publishedAt < winStart - stepSec || e.publishedAt > winEnd + stepSec) continue;
        let lo = 0, hi = ts.length - 1, best = -1, bestDiff = Infinity;
        while (lo <= hi) {
          const mid = (lo + hi) >> 1;
          const d = Math.abs(ts[mid] - e.publishedAt);
          if (d < bestDiff) { bestDiff = d; best = mid; }
          if (ts[mid] < e.publishedAt) lo = mid + 1; else hi = mid - 1;
        }
        if (best >= 0 && bestDiff <= stepSec * 3) {
          const prev = econBarMap.get(best) ?? { count: 0, cat: e.category };
          econBarMap.set(best, { count: prev.count + 1, cat: e.category });
        }
      }
    }
    // SMA helpers — partial SMA200 if fewer than 200 bars (user requested)
    const sma = (i: number, period: number): number | null => {
      const eff = Math.min(period, i + 1);
      if (eff < 5) return null;
      let s = 0;
      for (let k = i - eff + 1; k <= i; k++) s += closes[k];
      return +(s / eff).toFixed(4);
    };
    // Rolling 20-bar average range + volume (prior bars only)
    const ranges = bars.map((b) => (((b as any).high ?? b.close) - ((b as any).low ?? b.close)));
    const vols = bars.map((b) => b.volume ?? 0);
    const rollingAvg = (arr: number[], i: number, win: number) => {
      const start = Math.max(0, i - win);
      const end = i; // exclude current bar
      if (end <= start) return 0;
      let s = 0;
      for (let k = start; k < end; k++) s += arr[k];
      return s / (end - start);
    };
    // Pre-compute per-bar flags
    type Flag = { idx: number; isElephant: boolean; bullElephant: boolean; bearElephant: boolean;
      bottomingTail: boolean; toppingTail: boolean; bull: boolean; sell: boolean; high: number; low: number };
    const flags: Flag[] = [];
    for (let i = 0; i < bars.length; i++) {
      const b = bars[i];
      const open = (b as any).open ?? b.close;
      const high = (b as any).high ?? b.close;
      const low = (b as any).low ?? b.close;
      const range = high - low;
      const body = Math.abs(b.close - open);
      const upperWick = high - Math.max(open, b.close);
      const lowerWick = Math.min(open, b.close) - low;
      const avgR = rollingAvg(ranges, i, 20);
      const avgV = rollingAvg(vols, i, 20);
      const isElephant = avgR > 0 && avgV > 0 && range > avgR * 1.5 && (b.volume ?? 0) > avgV * 1.5;
      const bullElephant = isElephant && b.close > open;
      const bearElephant = isElephant && b.close < open;
      const tailRef = Math.max(body, range * 0.05); // avoid div-by-zero
      const bottomingTail = lowerWick >= tailRef * 2 && lowerWick > upperWick;
      const toppingTail = upperWick >= tailRef * 2 && upperWick > lowerWick;
      const s20 = sma(i, 20);
      const bull = bullElephant || (bottomingTail && s20 != null && b.close > s20);
      const sell = bearElephant || (toppingTail && s20 != null && b.close < s20);
      flags.push({ idx: i, isElephant, bullElephant, bearElephant, bottomingTail, toppingTail, bull, sell, high, low });
    }
    // Keep only last 3 BULL + 3 SELL labels
    const keepBull = new Set<number>();
    const keepSell = new Set<number>();
    for (let i = flags.length - 1; i >= 0 && (keepBull.size < 3 || keepSell.size < 3); i--) {
      if (flags[i].bull && keepBull.size < 3) keepBull.add(i);
      else if (flags[i].sell && keepSell.size < 3) keepSell.add(i);
    }
    // Stagger label offsets so consecutive nearby signals (within 5 bars)
    // don't overlap — alternate 8/18px equivalents (scaled to price space).
    const labeled = [...keepBull, ...keepSell].sort((a, b) => a - b);
    const staggerExtra = new Map<number, number>();
    let alt = 0;
    for (let k = 0; k < labeled.length; k++) {
      const idx = labeled[k];
      const prev = k > 0 ? labeled[k - 1] : -999;
      if (idx - prev <= 5) { alt = 1 - alt; staggerExtra.set(idx, alt); }
      else { alt = 0; staggerExtra.set(idx, 0); }
    }
    return bars.map((b, i) => {
      const open = (b as any).open ?? b.close;
      const high = (b as any).high ?? b.close;
      const low = (b as any).low ?? b.close;
      const start = Math.min(open, b.close);
      const body = Math.abs(b.close - open);
      // Glue BUY/SELL arrows right against the wick tip — tiny offset only.
      const baseOffset = Math.max((high - low) * 0.015, b.close * 0.00005, 0.005);
      const extra = staggerExtra.get(i) ? baseOffset * 0.8 : 0;
      const offset = baseOffset + extra;
      const s20 = sma(i, 20);
      const s200 = sma(i, 200);
      return {
        date: b.date,
        open, high, low, close: b.close, volume: b.volume,
        candleStart: +start.toFixed(4),
        candleBody: +(body || (b.close * 0.0005)).toFixed(4),
        candleColor: b.close >= open ? "#39d353" : "#f85149",
        wickStart: +low.toFixed(4),
        wickRange: +(high - low).toFixed(4),
        candleRange: [+low.toFixed(4), +high.toFixed(4)] as [number, number],
        sma20: s20, sma200: s200, sma9: b.sma9 ?? null, sma15: b.sma15 ?? null,
        bbUpper: b.bbUpper ?? null, bbMiddle: b.bbMiddle ?? null, bbLower: b.bbLower ?? null,
        bullLabelY: keepBull.has(i) ? +(low - offset).toFixed(4) : null,
        sellLabelY: keepSell.has(i) ? +(high + offset).toFixed(4) : null,
        bottomingTailY: flags[i].bottomingTail && !keepBull.has(i) ? +(low - offset * 0.5).toFixed(4) : null,
        toppingTailY: flags[i].toppingTail && !keepSell.has(i) ? +(high + offset * 0.5).toFixed(4) : null,
        isElephant: flags[i].isElephant,
        newsMarkerY: newsBarMap.has(i) ? +(high + offset * 2.2).toFixed(4) : null,
        newsCount: newsBarMap.get(i) ?? 0,
        econMarkerY: econBarMap.has(i) ? +(high + offset * 3.6).toFixed(4) : null,
        econCount: econBarMap.get(i)?.count ?? 0,
        econCat: econBarMap.get(i)?.cat ?? null,
      };
    });
  }, [displayData, chartMode, stitchedIntradayBars, newsItems, econItems]);

  const masterVisibleData = useMemo(() => {
    if (!masterData.length) return [];
    const fallback = chartMode === "D" ? masterData.length : Math.min(masterData.length, 40);
    const [start, end] = masterVisibleRange ?? [Math.max(0, masterData.length - fallback), masterData.length - 1];
    return masterData.slice(Math.max(0, start), Math.min(masterData.length, end + 1));
  }, [masterData, masterVisibleRange, chartMode]);
  const macdVisibleData = useMemo(() => {
    if (!macdCandleData.length) return [];
    const fallback = chartMode === "D" ? macdCandleData.length : Math.min(macdCandleData.length, 40);
    const [start, end] = macdVisibleRange ?? [Math.max(0, macdCandleData.length - fallback), macdCandleData.length - 1];
    return macdCandleData.slice(Math.max(0, start), Math.min(macdCandleData.length, end + 1));
  }, [macdCandleData, macdVisibleRange, chartMode]);
  // Price domains are recalculated from the bars currently in view, so the
  // right-side dollar scale follows the timeframe as the user swipes back.
  const masterPriceDomain = useMemo<[number, number] | ["auto", "auto"]>(() => {
    return getVisiblePriceDomain(masterVisibleData);
  }, [masterVisibleData]);
  const macdPriceDomain = useMemo<[number, number] | ["auto", "auto"]>(() => {
    return getVisiblePriceDomain(macdVisibleData);
  }, [macdVisibleData]);
  const macdOscDomain = useMemo<[number, number] | ["auto", "auto"]>(() => {
    if (!macdCandleData.length) return ["auto", "auto"];
    const sample = macdCandleData.slice(chartMode === "D" ? 0 : Math.max(0, macdCandleData.length - 90));
    const vals = sample.flatMap((d) => [d.macd ?? 0, d.macdSignal ?? 0, d.macdHist ?? 0]).filter((v) => Number.isFinite(v));
    if (!vals.length) return ["auto", "auto"];
    const maxAbs = Math.max(...vals.map((v) => Math.abs(v)), 0.05);
    return [+(-maxAbs * 1.15).toFixed(3), +(maxAbs * 1.15).toFixed(3)];
  }, [macdCandleData, chartMode]);
  const flowObvDomain = useMemo<[number, number] | ["auto", "auto"]>(() => {
    if (!flowChartData.length) return ["auto", "auto"];
    const sample = flowChartData.slice(chartMode === "D" ? 0 : Math.max(0, flowChartData.length - 40));
    const vals = sample.map((d) => d.obvPlot).filter((v) => Number.isFinite(v));
    if (!vals.length) return ["auto", "auto"];
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const mid = (lo + hi) / 2;
    const half = Math.max((hi - lo) / 2, Math.max(Math.abs(mid) * 0.03, 1));
    return [Math.floor(mid - half * 1.2), Math.ceil(mid + half * 1.2)];
  }, [flowChartData, chartMode]);
  const pxPerBarBase = chartMode === "D" ? 18 : intradayInterval === "1m" ? 16 : intradayInterval === "2m" ? 18 : intradayInterval === "5m" ? 22 : 28;
  const pxPerBar = Math.max(6, Math.round(pxPerBarBase * chartZoom));
  const masterChartWidth = Math.max(360, masterData.length * pxPerBar);
  const flowChartWidth = Math.max(360, flowChartData.length * Math.max(10, pxPerBar * 0.8));
  const macdChartWidth = Math.max(360, macdCandleData.length * pxPerBar);
  const syncVisibleRange = useCallback((el: HTMLDivElement | null, rows: number, chartWidth: number, setter: any) => {
    if (!el || rows <= 0) { setter(null); return; }
    const usableWidth = Math.max(1, el.clientWidth);
    const px = Math.max(1, chartWidth / rows);
    const start = Math.max(0, Math.floor(el.scrollLeft / px) - 2);
    const end = Math.min(rows - 1, Math.ceil((el.scrollLeft + usableWidth) / px) + 2);
    setter((prev: [number, number] | null) => prev?.[0] === start && prev?.[1] === end ? prev : [start, end]);
  }, []);
  useEffect(() => {
    const scrollLiveEdge = () => {
      for (const el of [masterScrollRef.current, flowScrollRef.current, macdScrollRef.current]) {
        if (el) el.scrollLeft = Math.max(0, el.scrollWidth - el.clientWidth);
      }
      syncVisibleRange(masterScrollRef.current, masterData.length, masterChartWidth, setMasterVisibleRange);
      syncVisibleRange(macdScrollRef.current, macdCandleData.length, macdChartWidth, setMacdVisibleRange);
    };
    const raf = requestAnimationFrame(scrollLiveEdge);
    const t = window.setTimeout(scrollLiveEdge, 250);
    return () => { cancelAnimationFrame(raf); window.clearTimeout(t); };
  }, [selectedStock, chartMode, intradayRange, intradayInterval, masterChartWidth, flowChartWidth, macdChartWidth, masterData.length, macdCandleData.length, syncVisibleRange]);
  // Decision strip — last bar metrics
  const decision = useMemo(() => {
    const last = masterData[masterData.length - 1];
    if (!last) {
      return {
        trend: "—" as "BULL" | "BEAR" | "—",
        vwapPos: "—" as "ABOVE" | "BELOW" | "—",
        vol: "—" as "SURGE" | "NORMAL" | "—",
        bb: "—" as "SQUEEZE" | "EXPANDING" | "—",
        macd: signal,
        bias: "NEUTRAL" as "STRONG BUY" | "STRONG SELL" | "NEUTRAL",
      };
    }
    const trend: "BULL" | "BEAR" | "—" =
      last.sma20 != null && last.sma200 != null ? (last.sma20 >= last.sma200 ? "BULL" : "BEAR") : "—";
    const vwapPos: "ABOVE" | "BELOW" | "—" =
      last.sma20 != null ? (last.close >= last.sma20 ? "ABOVE" : "BELOW") : "—";
    const last20 = masterData.slice(-21, -1);
    const avgVol = last20.length ? last20.reduce((s, b) => s + (b.volume ?? 0), 0) / last20.length : 0;
    const vol: "SURGE" | "NORMAL" | "—" =
      avgVol > 0 ? (((last.volume ?? 0) / avgVol) >= 2 ? "SURGE" : "NORMAL") : "—";
    const bb: "SQUEEZE" | "EXPANDING" | "—" = last.isElephant ? "EXPANDING" : "—";
    let bull = 0, bear = 0;
    if (trend === "BULL") bull++; else if (trend === "BEAR") bear++;
    if (vwapPos === "ABOVE") bull++; else if (vwapPos === "BELOW") bear++;
    if (vol === "SURGE" && (last.close >= last.open)) bull++;
    if (vol === "SURGE" && (last.close < last.open)) bear++;
    if (signal === "BUY") bull++; else if (signal === "SELL") bear++;
    const bias: "STRONG BUY" | "STRONG SELL" | "NEUTRAL" =
      bull >= 4 ? "STRONG BUY" : bear >= 4 ? "STRONG SELL" : "NEUTRAL";
    return { trend, vwapPos, vol, bb, macd: signal, bias };
  }, [masterData, signal]);

  // Watch every watchlist symbol; when its signal flips to BUY or SELL,
  // fire a web push to every subscribed device (5-min server-side cooldown).
  useEffect(() => {
    if (pushPerm !== "granted" || !isPro) return;
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
    if (pushPerm !== "granted" || !isPro) return;
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
    if (pushPerm !== "granted" || !isPro) return;
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
    setShowDetail(true);
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
    <div style={{ minHeight: "100vh", width: "100vw", maxWidth: "100vw", overflowX: "hidden", background: "#010409", color: "#e6edf3", fontFamily: mono, fontSize: 12, paddingTop: "env(safe-area-inset-top, 0px)", boxSizing: "border-box" }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;600;700&family=Orbitron:wght@700;900&display=swap');
        html, body { height: 100%; width: 100%; overflow-x: hidden; margin: 0; padding: 0; }
        body { padding-top: env(safe-area-inset-top, 0px); background: #010409; }
        ::-webkit-scrollbar { width: 4px; height: 4px; }
        ::-webkit-scrollbar-track { background: #010409; }
        ::-webkit-scrollbar-thumb { background: #21262d; border-radius: 2px; }
        * { box-sizing: border-box; }
        .stock-row:hover { background: #161b22 !important; cursor: pointer; }
        .btn-primary:hover { filter: brightness(1.2); }
        @keyframes pulse { 0%,100% { opacity:1; } 50% { opacity:0.4; } }
        @keyframes slideIn { from { transform: translateY(-20px); opacity:0; } to { transform: translateY(0); opacity:1; } }
        @keyframes flow-flash-buy {
          0%,100% { background: rgba(57,211,83,0.85); box-shadow: 0 0 12px rgba(57,211,83,0.9), 0 0 22px rgba(57,211,83,0.55); color: #03110a; }
          50%     { background: rgba(57,211,83,0.25); box-shadow: 0 0 4px rgba(57,211,83,0.4); color: #39d353; }
        }
        @keyframes flow-flash-sell {
          0%,100% { background: rgba(248,81,73,0.9); box-shadow: 0 0 12px rgba(248,81,73,0.95), 0 0 22px rgba(248,81,73,0.6); color: #1a0303; }
          50%     { background: rgba(248,81,73,0.25); box-shadow: 0 0 4px rgba(248,81,73,0.45); color: #f85149; }
        }
        .flow-flash-buy  { animation: flow-flash-buy 0.7s ease-in-out infinite; padding: 0 4px; border-radius: 3px; font-weight: 900 !important; }
        .flow-flash-sell { animation: flow-flash-sell 0.7s ease-in-out infinite; padding: 0 4px; border-radius: 3px; font-weight: 900 !important; }
      `}</style>

      {/* Header — two rows for mobile portrait fit */}
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #21262d", background: "#0d1117", position: "sticky", top: 0, zIndex: 100, overflow: "hidden" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
            <div style={{ fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 16, color: "#58a6ff", letterSpacing: 1 }}>⬡ BRYANTRADE</div>
            <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 2 }}>PRO TERMINAL</div>
            {/* OV chart is inline per-stock now */}
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          {globalSemis && (() => {
            const r = globalSemis;
            const color = r.level === "EXTREME" ? "#f85149" : r.level === "HIGH" ? "#ff7b29" : r.level === "ELEVATED" ? "#e3b341" : "#39d353";
            const impl = r.impliedNasdaqPct;
            const implStr = impl == null ? null : `${impl >= 0 ? "+" : ""}${impl.toFixed(2)}%`;
            const tip = `Semi risk from Asian/Philly indices — ${r.level} (${r.score}/100)\n\n${r.reason}\n\nImplied NQ drag: ${implStr ?? "—"}`;
            return (
              <span title={tip}
                style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 800, color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 6px", letterSpacing: 0.5, flexShrink: 0 }}>
                <span style={{ color: "#8b949e", fontWeight: 800 }}>SEMI RISK</span>
                {r.level} <span style={{ opacity: 0.7 }}>{r.score}</span>
                {implStr && (
                  <span style={{ color: impl! >= 0 ? "#39d353" : "#f85149", fontWeight: 700, opacity: 0.9 }}>NQ {implStr}</span>
                )}
              </span>
            );
          })()}
          {marketPulse?.vix?.price != null && (() => {
            const v = marketPulse.vix;
            const pct = v.changePct ?? 0;
            const color = (v.price ?? 0) >= 22 ? "#f85149" : (v.price ?? 0) >= 18 ? "#e3b341" : "#39d353";
            return (
              <span title={`CBOE Volatility Index (fear gauge)`}
                style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, fontWeight: 700, color, border: `1px solid ${color}`, borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}>
                <span style={{ color: "#8b949e", fontWeight: 800 }}>VIX</span>
                {v.price!.toFixed(2)} <span style={{ opacity: 0.7 }}>{pct >= 0 ? "+" : ""}{pct.toFixed(2)}%</span>
              </span>
            );
          })()}
          <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, color: "#39d353", flexShrink: 0 }}>
            <div style={{ width: 6, height: 6, borderRadius: "50%", background: "#39d353", animation: "pulse 2s infinite" }} />
            LIVE
          </div>
          {schwabTokens ? (
            <span
              title={schwabErr ? `Schwab error: ${schwabErr}` : `Schwab real-time quote for ${selectedStock}`}
              style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 10, fontWeight: 800, color: "#39d353", border: "1px solid #39d353", borderRadius: 4, padding: "2px 6px", flexShrink: 0 }}
            >
              <span style={{ color: "#8b949e", fontWeight: 800 }}>SCHWAB</span>
              {schwabQuote?.last != null ? `$${schwabQuote.last.toFixed(2)}` : "—"}
              {schwabQuote?.bid != null && schwabQuote?.ask != null && (
                <span style={{ color: "#8b949e", fontWeight: 700 }}>
                  {schwabQuote.bid.toFixed(2)}×{schwabQuote.ask.toFixed(2)}
                </span>
              )}
            </span>
          ) : (
            <button
              type="button"
              onClick={connectSchwab}
              title="Connect Schwab for real-time NBBO quotes"
              style={{ background: "rgba(57,211,83,0.12)", border: "1px solid #39d353", color: "#39d353", fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 4, cursor: "pointer", letterSpacing: 0.5, flexShrink: 0 }}
            >
              CONNECT SCHWAB
            </button>
          )}
          {trap.kind && (() => {
            const isBull = trap.kind === "BULL_TRAP";
            const color = isBull ? "#f85149" : "#39d353";
            const label = isBull ? "BULL TRAP" : "BEAR TRAP";
            return (
              <span
                title={trap.reason}
                style={{
                  display: "flex", alignItems: "center", gap: 4,
                  fontSize: 10, fontWeight: 900, letterSpacing: 0.5,
                  color: "#0d1117", background: color,
                  border: `1px solid ${color}`, borderRadius: 4,
                  padding: "2px 6px", flexShrink: 0,
                  animation: "pulse 1.4s ease-in-out infinite",
                }}
              >
                🪤 {label}
              </span>
            );
          })()}
          </div>
        </div>
        {/* Row 2: FUT strip full width */}
        {marketPulse?.futures && marketPulse.futures.length > 0 && (
          <div style={{ marginTop: 6, overflowX: "auto", whiteSpace: "nowrap" }}>
            <span style={{ display: "inline-flex", alignItems: "center", gap: 8, fontSize: 10, fontWeight: 700, border: "1px solid #21262d", borderRadius: 4, padding: "2px 6px" }}>
              <span style={{ color: "#8b949e", fontWeight: 800 }}>FUT</span>
              {marketPulse.futures.map((f: QuoteSnap) => {
                const pct = f.changePct ?? 0;
                const color = pct >= 0 ? "#39d353" : "#f85149";
                const label = f.symbol === "ES=F" ? "ES" : f.symbol === "NQ=F" ? "NQ" : f.symbol === "YM=F" ? "YM" : "RTY";
                const mom = futuresMomentum[f.symbol];
                const flashClass = mom === "BUY" ? "flow-flash-buy" : mom === "SELL" ? "flow-flash-sell" : undefined;
                const momTip = mom ? `  ·  momentum: ${mom} (last 10s)` : "";
                return (
                  <span
                    key={f.symbol}
                    title={`${f.name} futures: ${f.price?.toFixed(2) ?? "—"}${momTip}`}
                    className={flashClass}
                    style={{ color }}
                  >
                    {label} {pct >= 0 ? "+" : ""}{pct.toFixed(2)}%
                  </span>
                );
              })}
            </span>
          </div>
        )}
      </div>

      {/* Full-screen watchlist */}
      <div style={{ background: "#0d1117", overflow: "hidden", overflowY: "auto", maxHeight: "calc(100vh - env(safe-area-inset-top, 0px) - 49px)", width: "100%", maxWidth: "100vw", boxSizing: "border-box" }}>
          <div style={{ padding: "6px 6px", borderBottom: "1px solid #21262d", position: "relative" }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
              <div style={{ fontSize: 9, color: "#8b949e", letterSpacing: 1 }}>WATCHLIST</div>
              <button
                type="button"
                onClick={() => setShowScreener(true)}
                style={{ background: "rgba(88,166,255,0.15)", border: "1px solid #58a6ff", color: "#58a6ff", fontSize: 11, fontWeight: 800, padding: "6px 14px", borderRadius: 5, cursor: "pointer", letterSpacing: 1, fontFamily: mono }}
              >⚡ SCREENER</button>
            </div>
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
          <div style={{ display: "grid", gridTemplateColumns: "repeat(3, minmax(0, 1fr))", gap: 5, padding: "6px", width: "100vw", maxWidth: "100vw", boxSizing: "border-box" }}>
            {filteredStocks.map(sym => {
              const d = allData[sym] || [];
              const l = d[d.length - 1]; const p = d[d.length - 2];
              const chg = l && p ? ((l.close - p.close) / p.close) * 100 : 0;
              const sig: "BUY" | "SELL" | "HOLD" =
                watchlistMacdSignals[sym] ?? (d.length ? getMacdMomentumSignal(d).signal : "HOLD");
              const lq = live[sym];
              const liveChg = lq ? lq.changePercent : chg;
              const livePrice = lq ? lq.price : l?.close;
              const liveChgAbs = lq ? lq.change : (l && p ? l.close - p.close : 0);
              const pos = positions[sym];
              const pl = pos && livePrice != null ? (livePrice - pos.entry) * pos.shares : 0;
              const plPct = pos && livePrice != null && pos.entry > 0 ? ((livePrice - pos.entry) / pos.entry) * 100 : 0;
              const plColor = pl >= 0 ? "#39d353" : "#f85149";
              const tileBg =
                sig === "BUY" ? "rgba(57,211,83,0.15)" :
                sig === "SELL" ? "rgba(248,81,73,0.15)" :
                "rgba(227,179,65,0.10)";
              const tileBorderColor =
                sig === "BUY" ? "#39d353" :
                sig === "SELL" ? "#f85149" :
                "#e3b341";
              const oa = optionsActivity[sym];
              const oaShow = oa && (oa.callVolume + oa.putVolume) >= 50;
              const oaColor = oa?.bias === "BULL" ? "#39d353" : oa?.bias === "BEAR" ? "#f85149" : "#d29922";
              const oaLabel = oa?.bias === "BULL" ? "C↑" : oa?.bias === "BEAR" ? "P↓" : "UNU";
              const border =
                reorderModeSym === sym ? "2px solid #d2a8ff"
                : selectedStock === sym ? "1px solid #58a6ff"
                : `1px solid ${tileBorderColor}`;
              return (
                <div
                  key={sym}
                  className="stock-row"
                  onClick={() => onWatchlistRowClick(sym)}
                  data-stock-row={sym}
                  title={reorderModeSym && reorderModeSym !== sym ? `Move ${reorderModeSym} here` : "Select stock"}
                  style={{
                    position: "relative",
                    minWidth: 0,
                    height: 90,
                    padding: "10px 8px",
                    borderRadius: 6,
                    overflow: "hidden",
                    border,
                    background: tileBg,
                    userSelect: "none",
                    WebkitUserSelect: "none",
                    WebkitTouchCallout: "none",
                    WebkitTapHighlightColor: "transparent",
                  }}
                >
                  {/* Row 1 — ticker + reorder */}
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0 }}>
                      <button
                        onClick={(e) => { e.stopPropagation(); removeStock(sym); }}
                        title="Remove"
                        style={{ background: "transparent", border: "none", color: "#6e7681", cursor: "pointer", fontSize: 10, padding: 0, lineHeight: 1 }}
                      >✕</button>
                      {(() => {
                        const flow = flowSignals[sym];
                        if (!flow) return <span style={{ fontWeight: 700, fontSize: "clamp(13px, 3.5vw, 16px)", color: "#e6edf3" }}>{sym}</span>;
                        const cls = flow.kind === "BUY_SURGE" ? "flow-flash-buy" : "flow-flash-sell";
                        const tip = flow.kind === "BUY_SURGE"
                          ? `MASSIVE BUYING — ${flow.volRatio.toFixed(1)}× avg minute volume, +${flow.pricePct.toFixed(2)}% on the bar`
                          : `MASSIVE SELLING — ${flow.volRatio.toFixed(1)}× avg minute volume, ${flow.pricePct.toFixed(2)}% on the bar`;
                        return <span className={cls} style={{ fontWeight: 700, fontSize: "clamp(13px, 3.5vw, 16px)" }} title={tip}>{sym}</span>;
                      })()}
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 2 }}>
                      {reorderModeSym && reorderModeSym !== sym ? (
                        <span aria-hidden="true" style={{ color: "#58a6ff", fontSize: 14, fontWeight: 700 }}>⊕</span>
                      ) : null}
                      <button
                        type="button"
                        aria-label={reorderModeSym === sym ? "Cancel reorder" : "Reorder stock"}
                        title={reorderModeSym === sym ? "Cancel reorder" : "Tap, then tap destination tile"}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={(e) => { e.stopPropagation(); toggleReorderMode(sym); }}
                        style={{
                          background: "#161b22", border: "1px solid #30363d", color: "#8b949e",
                          cursor: "pointer", padding: "2px 5px", fontSize: 11, lineHeight: 1,
                          borderRadius: 3, touchAction: "manipulation",
                        }}
                      >{reorderModeSym === sym ? "✕" : "⋮⋮"}</button>
                    </div>
                  </div>

                  {/* Row 2 — company name */}
                  <div style={{ fontSize: "clamp(9px, 2.2vw, 11px)", color: "#8b949e", marginTop: 2, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", lineHeight: 1.1 }}>
                    {stockNames[sym] || ""}
                  </div>

                  {/* Row 3 — price (line 1) + change (line 2) */}
                  <div style={{ marginTop: 3, lineHeight: 1.15, overflow: "hidden", whiteSpace: "nowrap" }}>
                    {livePrice != null ? (
                      <>
                        <div style={{ fontWeight: 700, fontSize: "clamp(10px, 2.8vw, 13px)", color: "#e6edf3", overflow: "hidden", textOverflow: "ellipsis" }}>
                          ${livePrice.toFixed(2)}
                        </div>
                        <div style={{ fontSize: "clamp(9px, 2.2vw, 11px)", color: liveChg >= 0 ? "#39d353" : "#f85149", overflow: "hidden", textOverflow: "ellipsis" }}>
                          {liveChg >= 0 ? "+" : "-"}${Math.abs(liveChgAbs).toFixed(2)} ({liveChg >= 0 ? "+" : ""}{liveChg.toFixed(2)}%)
                        </div>
                      </>
                    ) : (
                      <span style={{ color: "#484f58", fontSize: "clamp(9px, 2.2vw, 11px)" }}>Loading…</span>
                    )}
                  </div>

                  {/* Row 4 — position P&L + $ button + options badge */}
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 4, marginTop: 3, fontSize: 9, lineHeight: 1.1, overflow: "hidden", whiteSpace: "nowrap" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, minWidth: 0, overflow: "hidden" }}>
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          const existing = positions[sym];
                          setEditingPos((cur) => (cur === sym ? null : sym));
                          setPosDraft({
                            shares: existing ? String(existing.shares) : "",
                            entry: existing ? String(existing.entry) : "",
                          });
                        }}
                        title={pos ? "Edit position" : "Add position"}
                        style={{ background: "transparent", border: "1px solid #30363d", color: pos ? "#e3b341" : "#6e7681", cursor: "pointer", fontSize: 9, fontWeight: 800, padding: "0 4px", borderRadius: 3, lineHeight: 1.4 }}
                      >$</button>
                      {pos && livePrice != null ? (
                        <>
                          <span style={{ color: "#8b949e", overflow: "hidden", textOverflow: "ellipsis" }}>
                            {pos.shares}sh @ ${pos.entry.toFixed(2)}
                          </span>
                          <span style={{ color: plColor, fontWeight: 700 }}>
                            {pl >= 0 ? "+" : "-"}${Math.abs(pl).toFixed(2)} ({plPct >= 0 ? "+" : ""}{plPct.toFixed(2)}%)
                          </span>
                          <button
                            type="button"
                            onClick={(e) => { e.stopPropagation(); setPositions((p) => { const n = { ...p }; delete n[sym]; return n; }); }}
                            title="Clear position"
                            style={{ background: "transparent", border: "1px solid #f85149", color: "#f85149", fontSize: 8, fontWeight: 800, padding: "1px 4px", borderRadius: 3, cursor: "pointer", marginLeft: 4 }}
                          >✕ CLEAR</button>
                        </>
                      ) : null}
                    </div>
                    {oaShow && (
                      <span
                        title={`Options flow ${oa.bias}${oa.unusual ? " · UNUSUAL" : ""}`}
                        style={{
                          fontSize: 9, fontWeight: 900, color: oaColor,
                          border: `1px solid ${oaColor}`, borderRadius: 2, padding: "0 3px",
                          background: oa.unusual ? `${oaColor}22` : undefined,
                        }}
                      >{oaLabel}</span>
                    )}
                  </div>

                  {/* Inline position editor overlay */}
                  {editingPos === sym && (
                    <div
                      onClick={(e) => e.stopPropagation()}
                      style={{ position: "absolute", inset: 0, background: "#0d1117ee", borderRadius: 6, padding: 6, display: "flex", flexDirection: "column", gap: 4, justifyContent: "center" }}
                    >
                      <input
                        type="number" inputMode="decimal" placeholder="shares"
                        value={posDraft.shares}
                        onChange={(e) => setPosDraft((d) => ({ ...d, shares: e.target.value }))}
                        style={{ background: "#010409", border: "1px solid #21262d", borderRadius: 3, padding: "2px 4px", color: "#e6edf3", fontSize: 10, fontFamily: mono }}
                      />
                      <input
                        type="number" inputMode="decimal" placeholder="cost $"
                        value={posDraft.entry}
                        onChange={(e) => setPosDraft((d) => ({ ...d, entry: e.target.value }))}
                        style={{ background: "#010409", border: "1px solid #21262d", borderRadius: 3, padding: "2px 4px", color: "#e6edf3", fontSize: 10, fontFamily: mono }}
                      />
                      <div style={{ display: "flex", gap: 3 }}>
                        <button
                          type="button"
                          onClick={() => {
                            const s = parseFloat(posDraft.shares);
                            const e = parseFloat(posDraft.entry);
                            const empty = posDraft.shares.trim() === "" && posDraft.entry.trim() === "";
                            if (empty || (Number.isFinite(s) && s === 0)) {
                              setPositions((p) => { const n = { ...p }; delete n[sym]; return n; });
                            } else if (Number.isFinite(s) && s > 0 && Number.isFinite(e) && e > 0) {
                              setPositions((p) => ({ ...p, [sym]: { shares: s, entry: e } }));
                            }
                            setEditingPos(null);
                          }}
                          style={{ flex: 1, background: "#238636", border: "none", color: "#fff", fontSize: 9, fontWeight: 700, padding: "3px 6px", borderRadius: 3, cursor: "pointer" }}
                        >Save</button>
                        <button
                          type="button"
                          onClick={() => setEditingPos(null)}
                          style={{ background: "transparent", border: "1px solid #30363d", color: "#f85149", fontSize: 9, padding: "3px 6px", borderRadius: 3, cursor: "pointer" }}
                        >✕</button>
                      </div>
                      {positions[sym] && (
                        <button
                          type="button"
                          onClick={() => { setPositions((p) => { const n = { ...p }; delete n[sym]; return n; }); setEditingPos(null); }}
                          style={{ background: "rgba(248,81,73,0.15)", border: "1px solid #f85149", color: "#f85149", fontSize: 10, fontWeight: 700, padding: "3px 8px", borderRadius: 3, cursor: "pointer", width: "100%", marginTop: 4 }}
                        >🗑 Clear Position</button>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          {watchlist.length === 0 && (
            <div style={{ padding: 16, fontSize: 10, color: "#8b949e", textAlign: "center" }}>
              Your watchlist is empty. Search above to add stocks.
            </div>
          )}
          <div style={{ fontSize: 9, color: "#8b949e", textAlign: "center", padding: "6px 0 12px" }}>▼ more</div>
      </div>

      {/* Detail overlay */}
      {showDetail && (
        <div style={{ position: "fixed", inset: 0, zIndex: 200, background: "#010409", overflowY: "auto", paddingTop: "env(safe-area-inset-top, 0px)" }}>
          <div style={{ position: "relative", zIndex: 50, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <button
              type="button"
              onClick={() => setShowDetail(false)}
              style={{ background: "transparent", border: "none", color: "#58a6ff", fontSize: 13, fontWeight: 700, cursor: "pointer", padding: "12px 16px", position: "relative", zIndex: 50 }}
            >← WATCHLIST</button>
          </div>
          <div style={{ padding: "6px 10px" }}>
          {/* Stock header — ultra-tight single row */}
          {(() => {
            const headPrice = liveSel?.price ?? liveSel?.regularPrice ?? last.close;
            const headPrev = liveSel?.previousClose ?? prev.close ?? 0;
            const headChange = headPrev ? headPrice - headPrev : change;
            const headChangePct = headPrev ? (headChange / headPrev) * 100 : changePct;
            const sess = liveSel?.session;
            const sessLabel = sess === "PRE" ? "PRE" : sess === "POST" ? "AH" : sess === "REGULAR" ? "LIVE" : sess === "OVERNIGHT" ? "24H" : sess ? "CLSD" : null;
            const sessColor = sess === "REGULAR" ? "#39d353" : sess === "PRE" ? "#58a6ff" : sess === "POST" ? "#d2a8ff" : sess === "OVERNIGHT" ? "#ff9b3d" : "#8b949e";
            const siBase = shorts[selectedStock];
            const sf = schwabFundamentals[selectedStock];
            // Prefer Schwab's shortIntToFloat (it's authoritative and refreshed
            // daily). Fall back to Nasdaq/stockanalysis blend.
            const pct = sf?.shortIntToFloat ?? siBase?.shortPercentOfFloat ?? null;
            const riskFromPct = pct == null
              ? "UNKNOWN"
              : pct >= 30 ? "EXTREME" : pct >= 20 ? "HIGH" : pct >= 10 ? "MODERATE" : "LOW";
            const si = siBase ?? (sf ? {
              symbol: selectedStock,
              floatShares: null,
              sharesOutstanding: sf.sharesOutstanding,
              sharesShort: null,
              shortPercentOfFloat: sf.shortIntToFloat,
              shortPercentOfShares: null,
              shortRatio: sf.shortIntDayToCover,
              shortDate: null,
              risk: riskFromPct as ShortInterest["risk"],
            } as ShortInterest : undefined);
            const effectiveRisk = si?.risk && si.risk !== "UNKNOWN" ? si.risk : riskFromPct;
            const siColor = effectiveRisk === "EXTREME" ? "#f85149" : effectiveRisk === "HIGH" ? "#ff7b29" : effectiveRisk === "MODERATE" ? "#e3b341" : effectiveRisk === "LOW" ? "#39d353" : "#8b949e";
            const fmtM = (n: number | null | undefined) => n == null ? "—" : n >= 1e9 ? (n / 1e9).toFixed(2) + "B" : n >= 1e6 ? (n / 1e6).toFixed(1) + "M" : n.toLocaleString();
            const bidVal = liveSel?.bid;
            const askVal = liveSel?.ask;
            const markRef = liveSel?.price ?? liveSel?.regularPrice;
            // Show any positive, finite quote — server already filtered junk.
            const bidOk = bidVal != null && Number.isFinite(bidVal) && bidVal > 0;
            const askOk = askVal != null && Number.isFinite(askVal) && askVal > 0;
            // Prefer Schwab's authoritative session VWAP when present; fall back
            // to the locally computed VWAP from intraday bars.
            const vwap = schwabQuote?.vwap ?? watchlistVwap[selectedStock];
            return (
              <>
                {/* Row 1: SYMBOL  PRICE  CHANGE  (session badge) */}
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 18, color: "#e6edf3", lineHeight: 1 }}>{selectedStock}</span>
                  {headPrice != null ? (
                    <>
                      <span style={{ fontSize: 18, fontWeight: 700, color: "#e6edf3", lineHeight: 1 }}>${headPrice.toFixed(2)}</span>
                      <span style={{ fontSize: 11, fontWeight: 600, color: headChange >= 0 ? "#39d353" : "#f85149", lineHeight: 1 }}>
                        {headChange >= 0 ? "▲" : "▼"}{headChange >= 0 ? "+" : ""}${Math.abs(headChange).toFixed(2)} ({headChangePct >= 0 ? "+" : ""}{headChangePct.toFixed(2)}%)
                      </span>
                    </>
                  ) : <span style={{ fontSize: 13, color: "#8b949e" }}>…</span>}
                  {sessLabel && (
                    <span style={{ fontSize: 8, fontWeight: 700, color: sessColor, border: `1px solid ${sessColor}`, borderRadius: 3, padding: "1px 4px", lineHeight: 1 }}>● {sessLabel}</span>
                  )}
                </div>
                {/* Row 2: BID  ASK  VWAP */}
                <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 10, marginBottom: 6, fontSize: 11, fontWeight: 700, color: "#8b949e", lineHeight: 1 }}>
                  <span title={`Bid${liveSel?.bidSize != null ? ` × ${liveSel.bidSize}` : ""}${liveSel?.syntheticBidAsk ? " · estimated from latest Yahoo chart bar" : ""}`}>
                    BID <span style={{ color: bidOk ? "#f85149" : "#484f58" }}>{bidOk ? `$${bidVal!.toFixed(2)}` : "—"}</span>
                  </span>
                  <span title={`Ask${liveSel?.askSize != null ? ` × ${liveSel.askSize}` : ""}${liveSel?.syntheticBidAsk ? " · estimated from latest Yahoo chart bar" : ""}`}>
                    ASK <span style={{ color: askOk ? "#39d353" : "#484f58" }}>{askOk ? `$${askVal!.toFixed(2)}` : "—"}</span>
                  </span>
                  <span title="Intraday volume-weighted average price">
                    VWAP <span style={{ color: vwap == null || headPrice == null ? "#484f58" : headPrice >= vwap ? "#39d353" : "#f85149" }}>{vwap != null ? `$${vwap.toFixed(2)}` : "—"}</span>
                  </span>
                </div>
                {/* Mini stat strip */}
                <div style={{ display: "flex", flexWrap: "wrap", gap: 10, marginBottom: 6, fontSize: 10, color: "#8b949e", lineHeight: 1.2 }}>
                  <span>RSI <span style={{ color: (last.rsi ?? 50) < 30 ? "#39d353" : (last.rsi ?? 50) > 70 ? "#f85149" : "#e6edf3", fontWeight: 700 }}>{last.rsi?.toFixed(1) ?? "—"}</span></span>
                  <span>MACD <span style={{ color: (last.macdHist ?? 0) > 0 ? "#39d353" : "#f85149", fontWeight: 700 }}>{last.macdHist?.toFixed(3) ?? "—"}</span></span>
                  <span>SMA9 <span style={{ color: "#79c0ff", fontWeight: 700 }}>${last.sma9?.toFixed(2) ?? "—"}</span></span>
                  <span style={{ display: "flex", gap: 10, flexBasis: "100%" }}>
                    <span
                      title={si ? `Short interest\nFloat: ${fmtM(si.floatShares)}\nShares short: ${fmtM(si.sharesShort)}\nShort % of float: ${pct?.toFixed(2) ?? "—"}%\nDays to cover: ${si.shortRatio?.toFixed(1) ?? "—"}\nRisk: ${si.risk}` : "Short interest data unavailable"}
                      style={{ cursor: "help" }}>
                      SHORT/FLOAT <span style={{ color: siColor, fontWeight: 800 }}>{pct != null ? `${pct.toFixed(1)}%` : "—"}</span>
                      {effectiveRisk && effectiveRisk !== "UNKNOWN" && <span style={{ color: siColor, fontSize: 8, marginLeft: 3 }}>{effectiveRisk}</span>}
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
                  {(() => {
                    const oa = selectedOptionsActivity?.items?.[selectedStock] ?? optionsActivity[selectedStock];
                    // Prefer Schwab's authoritative option-chain volume when connected.
                    const sts = schwabTopStrikes && schwabTopStrikes.symbol === selectedStock ? schwabTopStrikes : null;
                    if (!oa && !sts) return null;
                    const buckets = oa?.expiries ?? [];
                    const bucket = buckets[0];
                    // Build unified view with top-2 strikes per side when Schwab
                    // is connected; fall back to top-1 from Yahoo/CBOE otherwise.
                    const view: {
                      label: string; dte: number | null;
                      topCalls: { strike: number; pct: number }[];
                      topPuts: { strike: number; pct: number }[];
                      pcRatio: number | null;
                      callVolume: number | null; putVolume: number | null;
                    } = sts
                      ? {
                          label: sts.label ?? "Next", dte: sts.dte,
                          topCalls: (sts.topCalls && sts.topCalls.length ? sts.topCalls : (sts.topCallStrike != null && sts.topCallPct != null ? [{ strike: sts.topCallStrike, pct: sts.topCallPct }] : [])),
                          topPuts:  (sts.topPuts  && sts.topPuts.length  ? sts.topPuts  : (sts.topPutStrike  != null && sts.topPutPct  != null ? [{ strike: sts.topPutStrike,  pct: sts.topPutPct  }] : [])),
                          pcRatio: sts.pcRatio ?? null,
                          callVolume: sts.callVolume, putVolume: sts.putVolume,
                        }
                      : bucket
                        ? { label: bucket.label, dte: bucket.dte,
                            topCalls: bucket.topCallStrike != null && bucket.topCallPct != null ? [{ strike: bucket.topCallStrike, pct: bucket.topCallPct }] : [],
                            topPuts:  bucket.topPutStrike  != null && bucket.topPutPct  != null ? [{ strike: bucket.topPutStrike,  pct: bucket.topPutPct  }] : [],
                            pcRatio: null, callVolume: null, putVolume: null }
                        : { label: "All", dte: null,
                            topCalls: oa!.topCallStrike != null && oa!.topCallPct != null ? [{ strike: oa!.topCallStrike, pct: oa!.topCallPct }] : [],
                            topPuts:  oa!.topPutStrike  != null && oa!.topPutPct  != null ? [{ strike: oa!.topPutStrike,  pct: oa!.topPutPct  }] : [],
                            pcRatio: null, callVolume: null, putVolume: null };
                    const hasCall = view.topCalls.length > 0;
                    const hasPut = view.topPuts.length > 0;
                    if (!hasCall && !hasPut && buckets.length === 0 && !sts) return null;
                    const nextLabel = view.label;
                    const nextDte = view.dte;
                    const pcr = view.pcRatio;
                    const pcColor = pcr == null ? "#8b949e" : pcr >= 1.0 ? "#f85149" : pcr >= 0.7 ? "#e3b341" : "#39d353";
                    const pcLabel = pcr == null ? "" : pcr >= 1.0 ? "BEARISH" : pcr >= 0.7 ? "NEUTRAL" : "BULLISH";
                    return (
                      <span style={{ display: "flex", gap: 10, flexBasis: "100%", flexWrap: "wrap", alignItems: "center" }}>
                        {nextLabel && (
                          <span title="Nearest current listed options expiration" style={{ color: "#58a6ff", border: "1px solid #21262d", borderRadius: 4, padding: "2px 4px" }}>
                            NEXT EXP {nextLabel}{nextDte != null ? ` · ${nextDte}d` : ""}{sts ? " · Schwab" : ""}
                          </span>
                        )}
                        {pcr != null && (
                          <span title={`Put/Call ratio for ${view.label}: ${pcr.toFixed(2)}\n<0.70 bullish · 0.70-1.00 neutral · ≥1.00 bearish\nCall vol ${view.callVolume?.toLocaleString() ?? "—"} · Put vol ${view.putVolume?.toLocaleString() ?? "—"}`}
                            style={{ color: pcColor, border: `1px solid ${pcColor}`, borderRadius: 4, padding: "2px 4px", fontWeight: 800 }}>
                            P/C {pcr.toFixed(2)} <span style={{ opacity: 0.75, marginLeft: 2 }}>{pcLabel}</span>
                          </span>
                        )}
                        {hasCall && view.topCalls.map((c, i) => (
                          <span key={`c${i}`} title={`${(c.pct * 100).toFixed(1)}% of ${view.label} call flow at $${c.strike}`}>
                            {i === 0 ? "CALL TGT" : "→"} <span style={{ color: "#39d353", fontWeight: 800 }}>${c.strike.toFixed(2)}</span>
                            <span style={{ color: "#39d353", marginLeft: 3 }}>· {(c.pct * 100).toFixed(1)}%</span>
                            {i === 0 && <span style={{ color: "#8b949e", marginLeft: 4 }}>flow share</span>}
                          </span>
                        ))}
                        {hasPut && view.topPuts.map((p, i) => (
                          <span key={`p${i}`} title={`${(p.pct * 100).toFixed(1)}% of ${view.label} put flow at $${p.strike}`}>
                            {i === 0 ? "PUT TGT" : "→"} <span style={{ color: "#f85149", fontWeight: 800 }}>${p.strike.toFixed(2)}</span>
                            <span style={{ color: "#f85149", marginLeft: 3 }}>· {(p.pct * 100).toFixed(1)}%</span>
                            {i === 0 && <span style={{ color: "#8b949e", marginLeft: 4 }}>flow share</span>}
                          </span>
                        ))}
                      </span>
                    );
                  })()}
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
              {(["24H", "1D", "2D", "5D"] as const).map((r) => (
                <button key={r} onClick={() => { setChartMode("INTRADAY"); setIntradayRange(r); }}
                  style={{ background: chartMode === "INTRADAY" && intradayRange === r ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: chartMode === "INTRADAY" && intradayRange === r ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: mono }}>
                  {r}{r === "24H" && !schwabTokens ? "*" : ""}
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
              {(["1m", "2m", "5m", "15m"] as const).map((interval) => (
                <button key={interval} onClick={() => { setChartMode("INTRADAY"); setIntradayInterval(interval); }}
                  style={{ background: chartMode === "INTRADAY" && intradayInterval === interval ? "#21262d" : "transparent", border: "1px solid #21262d", borderRadius: 4, padding: "2px 8px", fontSize: 10, color: chartMode === "INTRADAY" && intradayInterval === interval ? "#58a6ff" : "#8b949e", cursor: "pointer", fontFamily: mono }}>
                  {interval}
                </button>
              ))}
            </div>
          </div>

          {/* Price chart — follows the selected range/interval buttons */}
          <ChartCard
            title="⚡ PRICE · MOVING AVERAGES · BOLLINGER / OV SIGNALS"
            titleRight={
              <span style={{ display: "inline-flex", gap: 6, alignItems: "center", marginLeft: 6 }}>
                <span style={{ fontSize: 9, color: "#8b949e" }}>{chartMode === "D" ? `${chartRange}D` : `${intradayRange} : ${intradayInterval}`} · live edge</span>
                <button onClick={() => setChartZoom((z) => Math.max(0.4, +(z / 1.25).toFixed(2)))}
                  title="Zoom out" style={{ background: "transparent", border: "1px solid #21262d", borderRadius: 4, color: "#8b949e", fontSize: 11, lineHeight: 1, padding: "2px 6px", cursor: "pointer", fontFamily: mono }}>−</button>
                <button onClick={() => setChartZoom(1)}
                  title="Reset zoom" style={{ background: "transparent", border: "1px solid #21262d", borderRadius: 4, color: "#8b949e", fontSize: 9, padding: "2px 5px", cursor: "pointer", fontFamily: mono }}>{Math.round(chartZoom * 100)}%</button>
                <button onClick={() => setChartZoom((z) => Math.min(4, +(z * 1.25).toFixed(2)))}
                  title="Zoom in" style={{ background: "transparent", border: "1px solid #21262d", borderRadius: 4, color: "#8b949e", fontSize: 11, lineHeight: 1, padding: "2px 6px", cursor: "pointer", fontFamily: mono }}>+</button>
              </span>
            }
            legend={[
              { label: "Bullish candle", color: "#39d353" },
              { label: "Bearish candle", color: "#f85149" },
              { label: "20MA", color: "#ffffcc" },
              { label: "200MA", color: "#8b1a1a" },
              { label: "BUY signal", color: "#39d353" },
              { label: "SELL signal", color: "#f85149" },
            ]}
          >
            <div style={{ position: "relative" }}>
            {/* Sticky Y-axis overlay (RIGHT side) so dollar prices stay
                pinned to the live edge while the user pans the time axis. */}
            <div style={{ position: "absolute", right: 0, top: 0, width: PRICE_AXIS_WIDTH, height: 430, pointerEvents: "none", zIndex: 2, background: "linear-gradient(to left, #0d1117 78%, rgba(13,17,23,0))" }}>
              <ResponsiveContainer width="100%" height={430}>
                <ComposedChart data={masterVisibleData} margin={{ top: 8, right: 0, left: 0, bottom: 20 }}>
                  <YAxis orientation="right" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} domain={masterPriceDomain} allowDataOverflow ticks={niceTicks(masterPriceDomain, 7)} tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={PRICE_AXIS_WIDTH - 2} />
                </ComposedChart>
              </ResponsiveContainer>
            </div>
            <div ref={masterScrollRef}
              onScroll={(e) => syncVisibleRange(e.currentTarget, masterData.length, masterChartWidth, setMasterVisibleRange)}
              onTouchStart={(e) => {
                if (e.touches.length === 2) {
                  const dx = e.touches[0].clientX - e.touches[1].clientX;
                  const dy = e.touches[0].clientY - e.touches[1].clientY;
                  (e.currentTarget as any)._pinchStart = Math.hypot(dx, dy);
                  (e.currentTarget as any)._pinchZoom = chartZoom;
                }
              }}
              onTouchMove={(e) => {
                const el: any = e.currentTarget;
                if (e.touches.length === 2 && el._pinchStart) {
                  e.preventDefault();
                  const dx = e.touches[0].clientX - e.touches[1].clientX;
                  const dy = e.touches[0].clientY - e.touches[1].clientY;
                  const dist = Math.hypot(dx, dy);
                  const ratio = dist / el._pinchStart;
                  setChartZoom(Math.max(0.4, Math.min(4, +(el._pinchZoom * ratio).toFixed(2))));
                }
              }}
              onTouchEnd={(e) => { (e.currentTarget as any)._pinchStart = 0; }}
              style={{ width: `calc(100% - ${PRICE_AXIS_WIDTH}px)`, overflowX: "auto", WebkitOverflowScrolling: "touch", touchAction: "pan-x pinch-zoom" }}>
            <div style={{ width: masterChartWidth, height: 430 }}>
            <ResponsiveContainer width="100%" height={430}>
              <ComposedChart data={masterData} margin={{ top: 8, right: 4, left: 4, bottom: 20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="date" stroke="#8b949e" fontSize={8} angle={-30} textAnchor="end" tick={{ fontFamily: mono, fontSize: 8 }} interval="preserveStartEnd" minTickGap={20} />
                <YAxis orientation="right" hide domain={masterPriceDomain} allowDataOverflow width={0} />
                {/* True OHLC candle via custom shape — single range bar so YAxis fits the price band */}
                <Bar dataKey="candleRange" name="Candle" isAnimationActive={false} shape={<Candle />} />
                <Line type="monotone" dataKey="sma9" stroke="#79c0ff" strokeWidth={1.8} dot={false} name="SMA9" connectNulls />
                <Line type="monotone" dataKey="sma15" stroke="#d2a8ff" strokeWidth={1.5} dot={false} name="SMA15" connectNulls />
                <Line type="monotone" dataKey="sma20" stroke="#ffffcc" strokeWidth={2} dot={false} name="20MA" connectNulls />
                <Line type="monotone" dataKey="sma200" stroke="#8b1a1a" strokeWidth={2} dot={false} name="200MA" connectNulls />
                <Line type="monotone" dataKey="bbUpper" stroke="#6e7681" strokeWidth={1} strokeDasharray="3 3" dot={false} name="BB Upper" connectNulls />
                <Line type="monotone" dataKey="bbLower" stroke="#6e7681" strokeWidth={1} strokeDasharray="3 3" dot={false} name="BB Lower" connectNulls />
                {/* BULL labels (green, below candle) */}
                <Scatter
                  dataKey="bullLabelY"
                  isAnimationActive={false}
                  shape={(p: any) => p?.payload?.bullLabelY == null ? <g /> : (
                    <g>
                      <polygon points={`${p.cx - 4},${p.cy} ${p.cx + 4},${p.cy} ${p.cx},${p.cy - 5}`} fill="#39d353" />
                      <text x={p.cx} y={p.cy + 9} textAnchor="middle" fill="#39d353" fontSize={9} fontWeight={900}>BUY</text>
                    </g>
                  )}
                />
                {/* SELL labels (red, above candle) */}
                <Scatter
                  dataKey="sellLabelY"
                  isAnimationActive={false}
                  shape={(p: any) => p?.payload?.sellLabelY == null ? <g /> : (
                    <g>
                      <text x={p.cx} y={p.cy - 6} textAnchor="middle" fill="#f85149" fontSize={9} fontWeight={900}>SELL</text>
                      <polygon points={`${p.cx - 4},${p.cy} ${p.cx + 4},${p.cy} ${p.cx},${p.cy + 5}`} fill="#f85149" />
                    </g>
                  )}
                />
                {/* Small tail markers */}
                <Scatter dataKey="bottomingTailY" isAnimationActive={false}
                  shape={(p: any) => p?.payload?.bottomingTailY == null ? <g /> : (
                    <polygon points={`${p.cx - 3},${p.cy + 3} ${p.cx + 3},${p.cy + 3} ${p.cx},${p.cy - 3}`} fill="#39d353" fillOpacity={0.7} />
                  )} />
                <Scatter dataKey="toppingTailY" isAnimationActive={false}
                  shape={(p: any) => p?.payload?.toppingTailY == null ? <g /> : (
                    <polygon points={`${p.cx - 3},${p.cy - 3} ${p.cx + 3},${p.cy - 3} ${p.cx},${p.cy + 3}`} fill="#f85149" fillOpacity={0.7} />
                  )} />
                {/* 📰 News markers — anchored above the bar a headline landed on */}
                <Scatter dataKey="newsMarkerY" isAnimationActive={false}
                  shape={(p: any) => p?.payload?.newsMarkerY == null ? <g /> : (
                    <g>
                      <circle cx={p.cx} cy={p.cy} r={7} fill="#58a6ff" stroke="#0d1117" strokeWidth={1} />
                      <text x={p.cx} y={p.cy + 3} textAnchor="middle" fontSize={9} fontWeight={900} fill="#0d1117">N</text>
                      {p.payload.newsCount > 1 && (
                        <text x={p.cx + 8} y={p.cy - 4} fontSize={8} fontWeight={900} fill="#58a6ff">×{p.payload.newsCount}</text>
                      )}
                    </g>
                  )} />
                {/* 🟡 E — high-impact economic release (CPI/PCE/NFP/FOMC…) */}
                <Scatter dataKey="econMarkerY" isAnimationActive={false}
                  shape={(p: any) => p?.payload?.econMarkerY == null ? <g /> : (
                    <g>
                      <rect x={p.cx - 7} y={p.cy - 7} width={14} height={14} rx={2} fill="#e3b341" stroke="#0d1117" strokeWidth={1} />
                      <text x={p.cx} y={p.cy + 3} textAnchor="middle" fontSize={9} fontWeight={900} fill="#0d1117">E</text>
                      {p.payload.econCat && (
                        <text x={p.cx + 9} y={p.cy - 4} fontSize={7} fontWeight={900} fill="#e3b341">{p.payload.econCat}</text>
                      )}
                    </g>
                  )} />
              </ComposedChart>
            </ResponsiveContainer>
            {/* Volume sub-panel — yellow bars rising with volume, synced X with master chart */}
            <ResponsiveContainer width="100%" height={78}>
              <ComposedChart data={masterData} margin={{ top: 0, right: 8, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                <XAxis dataKey="date" stroke="#8b949e" fontSize={8} tick={{ fontFamily: mono, fontSize: 8 }} hide />
                <YAxis stroke="#8b949e" fontSize={9} width={55} tickFormatter={(v: number) => v >= 1e6 ? `${(v/1e6).toFixed(1)}M` : v >= 1e3 ? `${(v/1e3).toFixed(0)}k` : `${v}`} />
                <Bar dataKey="volume" fill="#e3b341" isAnimationActive={false} maxBarSize={7} />
              </ComposedChart>
            </ResponsiveContainer>
            </div>
            </div>
            </div>
            <div style={{ fontSize: 9, color: "#6e7681", textAlign: "center", padding: "3px 0" }}>← swipe to pan · pinch or ± to zoom · live edge on right →</div>
          </ChartCard>

          {/* Day-trader VWAP + Cumulative Delta — replaces MACD momentum.
              Top pane: candles with session-anchored VWAP and ±1σ bands.
              Bottom pane: signed-volume Cumulative Delta (aggressor proxy)
              with per-bar delta histogram — highlights absorption/exhaustion
              divergences that day traders use for reversal reads. */}
          <ChartCard
            title="⚡ DAY-TRADER · VWAP BANDS + CUMULATIVE DELTA"
            titleRight={<span style={{ fontSize: 9, color: "#8b949e", marginLeft: 6 }}>{chartMode === "D" ? `${chartRange}D` : `${intradayRange} : ${intradayInterval}`}</span>}
            legend={[
              { label: "Bullish candle", color: "#39d353" },
              { label: "Bearish candle", color: "#f85149" },
              { label: "VWAP", color: "#d2a8ff" },
              { label: "VWAP ±1σ", color: "#484f58" },
              { label: "Cum Δ (aggressor)", color: "#58a6ff" },
              { label: "Buy Δ bar", color: "#39d353" },
              { label: "Sell Δ bar", color: "#f85149" },
            ]}
          >
            <div style={{ position: "relative" }}>
              <div style={{ position: "absolute", right: 0, top: 0, width: PRICE_AXIS_WIDTH, height: 300, pointerEvents: "none", zIndex: 2, background: "linear-gradient(to left, #0d1117 78%, rgba(13,17,23,0))" }}>
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={macdVisibleData} margin={{ top: 8, right: 0, left: 0, bottom: 0 }}>
                    <YAxis orientation="right" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} domain={macdPriceDomain} allowDataOverflow ticks={niceTicks(macdPriceDomain, 6)} tickFormatter={(v: number) => `$${v.toFixed(2)}`} width={PRICE_AXIS_WIDTH - 2} />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            <div ref={macdScrollRef} onScroll={(e) => syncVisibleRange(e.currentTarget, macdCandleData.length, macdChartWidth, setMacdVisibleRange)} style={{ width: `calc(100% - ${PRICE_AXIS_WIDTH}px)`, overflowX: "auto", WebkitOverflowScrolling: "touch", touchAction: "pan-x" }}>
              <div style={{ width: macdChartWidth }}>
                <ResponsiveContainer width="100%" height={300}>
                  <ComposedChart data={macdCandleData} margin={{ top: 8, right: 4, left: 0, bottom: 0 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis dataKey="date" stroke="#8b949e" fontSize={8} tick={{ fontFamily: mono, fontSize: 8 }} interval="preserveStartEnd" minTickGap={20} hide />
                    <YAxis orientation="right" hide domain={macdPriceDomain} allowDataOverflow width={0} />
                    <Bar dataKey="candleRange" name="Candle" isAnimationActive={false} shape={<Candle />} />
                    <Line type="monotone" dataKey="vwapUpper" stroke="#484f58" strokeWidth={1} strokeDasharray="3 3" dot={false} name="VWAP +1σ" connectNulls />
                    <Line type="monotone" dataKey="vwapLower" stroke="#484f58" strokeWidth={1} strokeDasharray="3 3" dot={false} name="VWAP -1σ" connectNulls />
                    <Line type="monotone" dataKey="vwap" stroke="#d2a8ff" strokeWidth={1.75} dot={false} name="VWAP" connectNulls />
                    <Scatter dataKey="buyArrowY" isAnimationActive={false}
                      shape={(p: any) => p?.payload?.buyArrowY == null ? <g /> : (
                        <g>
                          <polygon points={`${p.cx - 5},${p.cy} ${p.cx + 5},${p.cy} ${p.cx},${p.cy - 7}`} fill="#39d353" />
                          <text x={p.cx} y={p.cy + 11} textAnchor="middle" fill="#39d353" fontSize={9} fontWeight={900}>BUY</text>
                        </g>
                      )} />
                    <Scatter dataKey="sellArrowY" isAnimationActive={false}
                      shape={(p: any) => p?.payload?.sellArrowY == null ? <g /> : (
                        <g>
                          <text x={p.cx} y={p.cy - 8} textAnchor="middle" fill="#f85149" fontSize={9} fontWeight={900}>SELL</text>
                          <polygon points={`${p.cx - 5},${p.cy} ${p.cx + 5},${p.cy} ${p.cx},${p.cy + 7}`} fill="#f85149" />
                        </g>
                      )} />
                  </ComposedChart>
                </ResponsiveContainer>
                <ResponsiveContainer width="100%" height={150}>
                  <ComposedChart data={macdCandleData} margin={{ top: 0, right: 8, left: 0, bottom: 16 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#21262d" />
                    <XAxis dataKey="date" stroke="#8b949e" fontSize={8} angle={-30} textAnchor="end" tick={{ fontFamily: mono, fontSize: 8 }} interval="preserveStartEnd" minTickGap={20} />
                    <YAxis yAxisId="delta" orientation="right" stroke="#8b949e" fontSize={9} tick={{ fontFamily: mono }} width={64}
                      tickFormatter={(v: number) => Math.abs(v) >= 1e6 ? `${(v/1e6).toFixed(1)}M` : Math.abs(v) >= 1e3 ? `${(v/1e3).toFixed(0)}k` : `${v}`}
                    />
                    <Bar yAxisId="delta" dataKey="deltaBar" name="Δ bar" isAnimationActive={false} maxBarSize={6}
                      shape={(p: any) => <rect x={p.x} y={Math.min(p.y, p.y + p.height)} width={p.width} height={Math.abs(p.height)} fill={(p.payload?.deltaBar ?? 0) >= 0 ? "#39d353" : "#f85149"} opacity={0.55} />}
                    />
                    <Line yAxisId="delta" type="monotone" dataKey="cumDelta" stroke="#58a6ff" strokeWidth={1.75} dot={false} name="Cum Δ" connectNulls />
                  </ComposedChart>
                </ResponsiveContainer>
              </div>
            </div>
            </div>
            <div style={{ fontSize: 9, color: "#6e7681", textAlign: "center", padding: "3px 0" }}>← swipe to pan · price above VWAP+σ = extended long · Cum Δ divergence vs price = absorption/exhaustion</div>
          </ChartCard>

          {/* Macro market-moving news (CNBC / MarketWatch / WSJ) */}
          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            {/* Prepended above macro news: dedicated feed for the yellow "E" chart markers */}
          </div>

          <div style={{ background: "#0d1117", border: "1px solid #21262d", borderRadius: 8, padding: 12, marginBottom: 12 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8, flexWrap: "wrap", gap: 8 }}>
              <div style={{ fontSize: 10, color: "#e3b341", letterSpacing: 1.5, fontWeight: 700 }}>
                🟡 E · ECONOMIC RELEASES (US HIGH-IMPACT)
              </div>
              <span style={{ fontSize: 9, color: "#8b949e" }}>Nasdaq Cal · Fed · BEA</span>
            </div>
            <div style={{ display: "grid", gap: 6 }}>
              {econItems.length === 0 && (
                <div style={{ fontSize: 10, color: "#8b949e" }}>Loading economic calendar…</div>
              )}
              {econItems.slice(0, 15).map((e, i) => (
                <a key={i} href={e.link} target="_blank" rel="noreferrer"
                  style={{ display: "flex", gap: 8, padding: "6px 8px", background: "#010409", borderRadius: 4, textDecoration: "none", color: "#e6edf3", fontSize: 11, lineHeight: 1.4, border: "1px solid #161b22" }}>
                  <span style={{ fontSize: 8, fontWeight: 800, color: "#e3b341", letterSpacing: 1, minWidth: 54, paddingTop: 2 }}>
                    {e.category}
                  </span>
                  <span style={{ flex: 1 }}>
                    {e.title}
                    <span style={{ display: "block", fontSize: 9, color: "#8b949e", marginTop: 2 }}>
                      {e.publisher} · {new Date(e.publishedAt * 1000).toLocaleString()}
                    </span>
                  </span>
                </a>
              ))}
            </div>
          </div>

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
      )}

      {/* SCREENER overlay */}
      {showScreener && (() => {
        const rows: ScreenerRow[] =
          screenerTab === "gainers" ? (screenerData?.gainers ?? []) :
          screenerTab === "losers" ? (screenerData?.losers ?? []) :
          (screenerData?.actives ?? []);
        const top = screenerData?.gainers?.[0];
        const bot = screenerData?.losers?.[0];
        const act = screenerData?.actives?.[0];
        const fmtVol = (v: number | null) => v == null ? "—" : v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}k` : `${v}`;
        const updated = screenerUpdatedAt ? new Date(screenerUpdatedAt).toLocaleTimeString() : "—";
        return (
          <div style={{ position: "fixed", inset: 0, zIndex: 300, background: "#010409", overflowY: "auto", paddingTop: "env(safe-area-inset-top, 0px)", fontFamily: mono }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 14px", borderBottom: "1px solid #21262d", position: "sticky", top: 0, background: "#010409", zIndex: 2 }}>
              <button onClick={() => setShowScreener(false)} style={{ background: "transparent", border: "none", color: "#58a6ff", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>← WATCHLIST</button>
              <div style={{ fontFamily: "Orbitron, sans-serif", fontWeight: 900, fontSize: 14, color: "#22d3ee", letterSpacing: 1 }}>⚡ BRYANTRADE SCREENER</div>
              <span style={{ width: 80 }} />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 14px", borderBottom: "1px solid #161b22", fontSize: 10, color: "#8b949e", flexWrap: "wrap" }}>
              <span>FROM 04:00</span>
              <button
                onClick={() => queryClient.invalidateQueries({ queryKey: ["screener"] })}
                style={{ background: "transparent", border: "1px solid #30363d", color: "#e6edf3", fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 3, cursor: "pointer" }}
              >REFRESH</button>
              <span>Updated {updated}</span>
              <span style={{ display: "inline-flex", alignItems: "center", gap: 5, color: "#39d353", fontWeight: 800 }}>
                <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#39d353", animation: "pulse 2s infinite" }} />
                LIVE
              </span>
              <span style={{ fontSize: 9, color: "#8b949e" }}>↻ {countdown}s</span>
            </div>
            {/* Summary strip */}
            <div style={{ padding: "6px 14px", fontSize: 10, color: "#8b949e", borderBottom: "1px solid #161b22" }}>
              {top && (<>TOP GAINER: <span style={{ color: "#e6edf3", fontWeight: 700 }}>{top.symbol}</span> <span style={{ color: "#39d353", fontWeight: 700 }}>+{(top.changePct ?? 0).toFixed(2)}%</span></>)}
              {bot && (<> · TOP LOSER: <span style={{ color: "#e6edf3", fontWeight: 700 }}>{bot.symbol}</span> <span style={{ color: "#f85149", fontWeight: 700 }}>{(bot.changePct ?? 0).toFixed(2)}%</span></>)}
              {act && (<> · MOST ACTIVE: <span style={{ color: "#e6edf3", fontWeight: 700 }}>{act.symbol}</span> {fmtVol(act.volume)} shares</>)}
            </div>
            {/* Tabs */}
            <div style={{ display: "flex", borderBottom: "1px solid #21262d" }}>
              {(["gainers", "losers", "actives"] as const).map((t) => {
                const active = screenerTab === t;
                const label = t === "gainers" ? "GAINERS" : t === "losers" ? "LOSERS" : "MOST ACTIVE";
                return (
                  <button key={t} onClick={() => setScreenerTab(t)} style={{ flex: 1, background: "transparent", border: "none", padding: "10px 8px", color: active ? "#58a6ff" : "#8b949e", borderBottom: active ? "2px solid #58a6ff" : "2px solid transparent", fontSize: 11, fontWeight: 800, cursor: "pointer", letterSpacing: 1, fontFamily: mono }}>{label}</button>
                );
              })}
            </div>
            {/* Rows */}
            {screenerFetching && rows.length === 0 ? (
              <div style={{ display: "flex", justifyContent: "center", padding: 40 }}>
                <div style={{ width: 24, height: 24, border: "2px solid #58a6ff", borderTopColor: "transparent", borderRadius: "50%", animation: "spin 0.8s linear infinite" }} />
                <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
              </div>
            ) : (
              <div>
                {rows.map((r, i) => {
                  const up = (r.changePct ?? 0) >= 0;
                  return (
                    <div key={r.symbol} style={{ padding: "10px 14px", borderBottom: "1px solid #161b22", display: "flex", alignItems: "center", gap: 10, background: i % 2 === 0 ? "#0d1117" : "#010409" }}>
                      <span style={{ width: 22, color: "#6e7681", fontSize: 10 }}>{i + 1}</span>
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 700, fontSize: 14, color: "#e6edf3" }}>{r.symbol}</div>
                        <div style={{ fontSize: 10, color: "#8b949e", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{r.name}</div>
                      </div>
                      <div style={{ textAlign: "right" }}>
                        <div style={{ fontSize: 13, color: "#e6edf3" }}>${r.price?.toFixed(2) ?? "—"}</div>
                        <div style={{ fontSize: 14, fontWeight: 800, color: up ? "#39d353" : "#f85149" }}>
                          {up ? "+" : ""}{(r.changePct ?? 0).toFixed(2)}%
                        </div>
                        <div style={{ fontSize: 10, color: "#8b949e" }}>Vol {fmtVol(r.volume)}</div>
                      </div>
                      <button
                        onClick={() => {
                          addStock({ symbol: r.symbol, name: r.name, exchange: "", type: "EQUITY" });
                        }}
                        style={{ fontSize: 10, color: "#39d353", border: "1px solid #39d353", background: "transparent", borderRadius: 3, padding: "2px 6px", cursor: "pointer", fontWeight: 800 }}
                      >+ ADD</button>
                    </div>
                  );
                })}
                {rows.length === 0 && (
                  <div style={{ padding: 20, fontSize: 11, color: "#8b949e", textAlign: "center" }}>No results.</div>
                )}
              </div>
            )}
          </div>
        );
      })()}

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

