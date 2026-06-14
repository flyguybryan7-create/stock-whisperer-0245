/**
 * VelezOpenIndicators
 * --------------------------------------------------------------
 * Oliver Velez "First 20 Minutes" toolkit. Pure calc functions
 * + a self-contained chart panel. See header comment in the
 * user's original spec for full details.
 */
import { useMemo } from "react";
import {
  ComposedChart, LineChart, Line, Scatter, ReferenceArea, ReferenceLine,
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
} from "recharts";

export type Candle = { time: number | string; open: number; high: number; low: number; close: number; volume?: number };

export function toMs(time: number | string) {
  return typeof time === "number" ? time : new Date(time).getTime();
}
function round2(n: number) { return Math.round(n * 100) / 100; }

export function calculateSMA(values: number[], period: number) {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((a, b) => a + b, 0) / period;
}

export function calculateSMASeries(values: number[], period: number) {
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function getSMABias(closes: number[]) {
  const sma20 = calculateSMA(closes, 20);
  const sma200 = calculateSMA(closes, 200);
  if (sma20 == null || sma200 == null) return { bias: "insufficient-data" as const, sma20, sma200, spread: null };
  const bias = sma20 > sma200 ? "bullish" : sma20 < sma200 ? "bearish" : "neutral";
  return { bias, sma20: round2(sma20), sma200: round2(sma200), spread: round2(sma20 - sma200) };
}

export function detectSMACrossover(closes: number[]) {
  if (closes.length < 201) return null;
  const s20 = calculateSMASeries(closes, 20);
  const s200 = calculateSMASeries(closes, 200);
  const n = closes.length;
  const [c20, c200, p20, p200] = [s20[n - 1], s200[n - 1], s20[n - 2], s200[n - 2]];
  if ([c20, c200, p20, p200].some((v) => v == null)) return null;
  if (p20! <= p200! && c20! > c200!) return "bullish-cross" as const;
  if (p20! >= p200! && c20! < c200!) return "bearish-cross" as const;
  return null;
}

export function calculateCCI(candles: Candle[], period = 5) {
  if (candles.length < period) return null;
  const tp = candles.map((c) => (c.high + c.low + c.close) / 3);
  const recent = tp.slice(-period);
  const smaTP = recent.reduce((a, b) => a + b, 0) / period;
  const meanDev = recent.reduce((s, v) => s + Math.abs(v - smaTP), 0) / period;
  if (meanDev === 0) return 0;
  const currentTP = tp[tp.length - 1];
  return (currentTP - smaTP) / (0.015 * meanDev);
}

export function calculateCCISeries(candles: Candle[], period = 5) {
  return candles.map((_, i) => {
    if (i + 1 < period) return null;
    return round2(calculateCCI(candles.slice(i + 1 - period, i + 1), period) ?? 0);
  });
}

export function getCCISignal(cci: number | null) {
  if (cci == null) return "insufficient-data";
  if (cci > 100) return "overbought";
  if (cci < -100) return "oversold";
  return "neutral";
}

type ElephantResult = { isElephant: boolean; direction: "bullish" | "bearish" | null; rangeRatio: number; volRatio: number };
export function detectElephantBar(candles: Candle[], lookback = 10, threshold = 1.8): ElephantResult {
  if (candles.length < lookback + 1) return { isElephant: false, direction: null, rangeRatio: 0, volRatio: 0 };
  const current = candles[candles.length - 1];
  const prior = candles.slice(-(lookback + 1), -1);
  const avgRange = prior.reduce((s, c) => s + (c.high - c.low), 0) / prior.length;
  const avgVolume = prior.reduce((s, c) => s + (c.volume || 0), 0) / prior.length;
  const currentRange = current.high - current.low;
  const rangeRatio = avgRange > 0 ? currentRange / avgRange : 0;
  const volRatio = avgVolume > 0 ? (current.volume || 0) / avgVolume : 0;
  const isElephant = rangeRatio >= threshold || volRatio >= threshold;
  const direction: "bullish" | "bearish" = current.close >= current.open ? "bullish" : "bearish";
  return { isElephant, direction, rangeRatio: round2(rangeRatio), volRatio: round2(volRatio) };
}

export function getElephantBarMarkers(candles: Candle[], lookback = 10, threshold = 1.8) {
  const markers: Array<{ index: number; time: number | string; price: number; direction: "bullish" | "bearish"; rangeRatio: number; volRatio: number }> = [];
  for (let i = lookback; i < candles.length; i++) {
    const result = detectElephantBar(candles.slice(0, i + 1), lookback, threshold);
    if (result.isElephant && result.direction) {
      const c = candles[i];
      markers.push({ index: i, time: c.time, price: result.direction === "bullish" ? c.high : c.low, direction: result.direction, rangeRatio: result.rangeRatio, volRatio: result.volRatio });
    }
  }
  return markers;
}

export function getMarketOpenTimestamp(referenceTime: number = Date.now()) {
  const date = new Date(referenceTime);
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hour12: false,
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? "";
  const year = get("year");
  const month = get("month");
  const day = get("day");
  const nyHour = parseInt(get("hour"), 10) % 24;
  const utcHour = date.getUTCHours();
  let diff = nyHour - utcHour;
  if (diff > 0) diff -= 24;
  if (diff < -12) diff += 24;
  const offset = `${diff <= 0 ? "-" : "+"}${String(Math.abs(diff)).padStart(2, "0")}:00`;
  return new Date(`${year}-${month}-${day}T09:30:00${offset}`).getTime();
}

export function getOpeningRange(candles: Candle[], marketOpenTimestamp: number, windowMinutes = 20) {
  if (!candles.length) return null;
  const windowEnd = marketOpenTimestamp + windowMinutes * 60 * 1000;
  const orCandles = candles.filter((c) => { const t = toMs(c.time); return t >= marketOpenTimestamp && t < windowEnd; });
  if (!orCandles.length) return null;
  return { high: Math.max(...orCandles.map((c) => c.high)), low: Math.min(...orCandles.map((c) => c.low)), candleCount: orCandles.length, windowEnd };
}

export function getOpeningRangeStatus(candles: Candle[], openingRange: ReturnType<typeof getOpeningRange>) {
  if (!openingRange) return { status: "no-data" as const, breakout: null, range: null };
  const last = candles[candles.length - 1];
  if (toMs(last.time) < openingRange.windowEnd) return { status: "forming" as const, breakout: null, range: openingRange };
  if (last.close > openingRange.high) return { status: "breakout-up" as const, breakout: "long" as const, range: openingRange };
  if (last.close < openingRange.low) return { status: "breakout-down" as const, breakout: "short" as const, range: openingRange };
  return { status: "inside-range" as const, breakout: null, range: openingRange };
}

export function getVelezSignal(candles: Candle[], options: { marketOpenTimestamp?: number; orWindowMinutes?: number; elephantLookback?: number; elephantThreshold?: number } = {}) {
  const last = candles[candles.length - 1];
  const {
    marketOpenTimestamp = getMarketOpenTimestamp(last ? toMs(last.time) : Date.now()),
    orWindowMinutes = 20, elephantLookback = 10, elephantThreshold = 1.8,
  } = options;
  const closes = candles.map((c) => c.close);
  const smaBias = getSMABias(closes);
  const crossover = detectSMACrossover(closes);
  const cci = calculateCCI(candles, 5);
  const cciSignal = getCCISignal(cci);
  const elephant = detectElephantBar(candles, elephantLookback, elephantThreshold);
  const openingRange = getOpeningRange(candles, marketOpenTimestamp, orWindowMinutes);
  const orStatus = getOpeningRangeStatus(candles, openingRange);
  let score = 0;
  const reasons: string[] = [];
  if (smaBias.bias === "bullish") { score += 1; reasons.push("20 SMA above 200 SMA — bullish trend bias"); }
  if (smaBias.bias === "bearish") { score -= 1; reasons.push("20 SMA below 200 SMA — bearish trend bias"); }
  if (crossover === "bullish-cross") { score += 1; reasons.push("20/200 SMA bullish crossover"); }
  if (crossover === "bearish-cross") { score -= 1; reasons.push("20/200 SMA bearish crossover"); }
  if (orStatus.breakout === "long") { score += 1; reasons.push("Price broke above the opening range high"); }
  if (orStatus.breakout === "short") { score -= 1; reasons.push("Price broke below the opening range low"); }
  if (cciSignal === "oversold") { score += 1; reasons.push("CCI(5) oversold — early reversal watch"); }
  if (cciSignal === "overbought") { score -= 1; reasons.push("CCI(5) overbought — early reversal watch"); }
  if (elephant.isElephant) {
    if (elephant.direction === "bullish") { score += 1; reasons.push("Bullish elephant bar — large buyer stepped in"); }
    else { score -= 1; reasons.push("Bearish elephant bar — large seller stepped in"); }
  }
  let signal: "STRONG BUY" | "BUY" | "NEUTRAL" | "SELL" | "STRONG SELL" = "NEUTRAL";
  if (score >= 3) signal = "STRONG BUY";
  else if (score >= 2) signal = "BUY";
  else if (score <= -3) signal = "STRONG SELL";
  else if (score <= -2) signal = "SELL";
  return { signal, score, reasons, smaBias, crossover, cci: cci != null ? round2(cci) : null, cciSignal, elephant, openingRange: orStatus };
}

function formatTime(ms: number) {
  return new Date(ms).toLocaleTimeString("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
}

const SIGNAL_STYLES: Record<string, string> = {
  "STRONG BUY": "text-emerald-400 border-emerald-400 bg-emerald-400/10",
  BUY: "text-emerald-300 border-emerald-300/50 bg-emerald-300/5",
  NEUTRAL: "text-gray-400 border-gray-500 bg-gray-500/10",
  SELL: "text-red-300 border-red-300/50 bg-red-300/5",
  "STRONG SELL": "text-red-400 border-red-400 bg-red-400/10",
};

function SignalBadge({ signal, score }: { signal: string; score: number }) {
  return (
    <span className={`px-3 py-1 rounded border text-xs font-bold tracking-wider ${SIGNAL_STYLES[signal]}`}>
      {signal} <span className="opacity-50 font-normal">({score > 0 ? "+" : ""}{score})</span>
    </span>
  );
}

function StatBox({ label, value, sub, tone = "neutral" }: { label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: "bull" | "bear" | "warn" | "neutral" }) {
  const toneColor = { bull: "text-emerald-400", bear: "text-red-400", warn: "text-amber-400", neutral: "text-gray-200" }[tone];
  return (
    <div className="border border-[#1e2730] rounded p-2 bg-[#0d1117]">
      <div className="text-[10px] uppercase tracking-wider text-gray-500">{label}</div>
      <div className={`text-sm font-bold ${toneColor}`}>{value}</div>
      {sub && <div className="text-[10px] text-gray-500 mt-0.5">{sub}</div>}
    </div>
  );
}

function ChartTooltip({ active, payload, label, chartData }: any) {
  if (!active || !payload?.length) return null;
  const row = chartData[label];
  return (
    <div className="bg-[#0d1117] border border-[#1e2730] rounded px-2 py-1 text-[11px] text-gray-300">
      <div className="text-gray-500">{row?.timeLabel}</div>
      {payload.map((p: any) => (
        <div key={p.dataKey} style={{ color: p.color }}>
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(2) : "—"}
        </div>
      ))}
    </div>
  );
}

export default function VelezChartPanel({ candles, ticker = "DEMO", marketOpenTimestamp }: { candles?: Candle[]; ticker?: string; marketOpenTimestamp?: number }) {
  const data = candles && candles.length > 0 ? candles : [];
  if (data.length === 0) {
    return <div className="bg-[#0a0e14] text-gray-400 p-6 rounded-lg border border-[#1e2730] text-center text-sm">Loading {ticker} 2-minute candles…</div>;
  }
  const openTs = marketOpenTimestamp ?? getMarketOpenTimestamp(toMs(data[0].time));
  const velez = useMemo(() => getVelezSignal(data, { marketOpenTimestamp: openTs }), [data, openTs]);
  const sma20 = useMemo(() => calculateSMASeries(data.map((c) => c.close), 20), [data]);
  const sma200 = useMemo(() => calculateSMASeries(data.map((c) => c.close), 200), [data]);
  const cciSeries = useMemo(() => calculateCCISeries(data, 5), [data]);
  const elephants = useMemo(() => getElephantBarMarkers(data), [data]);
  const openingRange = useMemo(() => getOpeningRange(data, openTs, 20), [data, openTs]);
  const chartData = data.map((c, i) => ({
    idx: i, timeLabel: formatTime(toMs(c.time)),
    close: c.close, sma20: sma20[i], sma200: sma200[i], cci: cciSeries[i],
  }));
  const bullElephants = elephants.filter((m) => m.direction === "bullish").map((m) => ({ idx: m.index, price: m.price }));
  const bearElephants = elephants.filter((m) => m.direction === "bearish").map((m) => ({ idx: m.index, price: m.price }));
  let orStart: number | null = null;
  let orEnd: number | null = null;
  if (openingRange) {
    const idxs = data.map((c, i) => ({ i, t: toMs(c.time) })).filter(({ t }) => t >= openTs && t < openingRange.windowEnd).map(({ i }) => i);
    if (idxs.length) { orStart = idxs[0]; orEnd = idxs[idxs.length - 1]; }
  }
  const tickFormatter = (idx: number) => chartData[idx]?.timeLabel ?? "";
  const orLabel = ({
    "no-data": "—", forming: "Forming…", "breakout-up": "Breakout ↑",
    "breakout-down": "Breakdown ↓", "inside-range": "Inside Range",
  } as Record<string, string>)[velez.openingRange.status];
  const crossLabel = velez.crossover === "bullish-cross" ? "Bullish ↑"
    : velez.crossover === "bearish-cross" ? "Bearish ↓" : "None";
  return (
    <div className="bg-[#0a0e14] text-gray-300 font-mono p-4 rounded-lg border border-[#1e2730] max-w-2xl mx-auto">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-lg font-bold text-gray-100">{ticker}</div>
          <div className="text-[10px] text-gray-500 uppercase tracking-wider">Velez · First 20 Minutes</div>
        </div>
        <SignalBadge signal={velez.signal} score={velez.score} />
      </div>
      <div className="flex gap-4 text-[10px] text-gray-500 mb-1 flex-wrap">
        <span><span className="inline-block w-2 h-2 rounded-full bg-gray-300 mr-1" />Price</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-sky-400 mr-1" />SMA 20</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-orange-400 mr-1" />SMA 200</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-yellow-400/60 mr-1" />Opening Range</span>
        <span><span className="inline-block w-2 h-2 rounded-full bg-emerald-400 mr-1" />/<span className="inline-block w-2 h-2 rounded-full bg-red-400 ml-1 mr-1" />Elephant Bar</span>
      </div>
      <ResponsiveContainer width="100%" height={240}>
        <ComposedChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <CartesianGrid stroke="#1e2730" strokeDasharray="3 3" />
          <XAxis dataKey="idx" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tickFormatter} stroke="#4b5563" tick={{ fontSize: 10 }} minTickGap={40} />
          <YAxis domain={["auto", "auto"]} stroke="#4b5563" tick={{ fontSize: 10 }} width={45} />
          <Tooltip content={<ChartTooltip chartData={chartData} />} />
          {orStart != null && openingRange && (
            <ReferenceArea x1={orStart} x2={orEnd!} y1={openingRange.low} y2={openingRange.high} fill="#facc15" fillOpacity={0.08} stroke="#facc15" strokeOpacity={0.4} strokeDasharray="2 2" />
          )}
          <Line type="monotone" dataKey="close" name="Price" stroke="#d1d5db" strokeWidth={1.5} dot={false} />
          <Line type="monotone" dataKey="sma20" name="SMA 20" stroke="#38bdf8" strokeWidth={1.5} dot={false} />
          <Line type="monotone" dataKey="sma200" name="SMA 200" stroke="#fb923c" strokeWidth={1.5} dot={false} />
          <Scatter data={bullElephants} dataKey="price" name="Elephant ▲" fill="#34d399" shape="triangle" />
          <Scatter data={bearElephants} dataKey="price" name="Elephant ▼" fill="#f87171" shape="triangle" />
        </ComposedChart>
      </ResponsiveContainer>
      <div className="text-[10px] text-gray-500 uppercase tracking-wider mt-2 mb-1">CCI (5)</div>
      <ResponsiveContainer width="100%" height={90}>
        <LineChart data={chartData} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
          <XAxis dataKey="idx" type="number" domain={["dataMin", "dataMax"]} tickFormatter={tickFormatter} stroke="#4b5563" tick={{ fontSize: 10 }} minTickGap={40} />
          <YAxis domain={[-200, 200]} stroke="#4b5563" tick={{ fontSize: 10 }} width={45} />
          <ReferenceLine y={100} stroke="#f87171" strokeDasharray="3 3" />
          <ReferenceLine y={-100} stroke="#34d399" strokeDasharray="3 3" />
          <ReferenceLine y={0} stroke="#4b5563" />
          <Tooltip content={<ChartTooltip chartData={chartData} />} />
          <Line type="monotone" dataKey="cci" name="CCI" stroke="#fbbf24" strokeWidth={1.5} dot={false} />
        </LineChart>
      </ResponsiveContainer>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2 mt-3">
        <StatBox label="SMA Bias" value={velez.smaBias.bias === "insufficient-data" ? "—" : velez.smaBias.bias.toUpperCase()}
          sub={velez.smaBias.sma20 != null ? `20: ${velez.smaBias.sma20} / 200: ${velez.smaBias.sma200}` : "need 200 bars"}
          tone={velez.smaBias.bias === "bullish" ? "bull" : velez.smaBias.bias === "bearish" ? "bear" : "neutral"} />
        <StatBox label="SMA Crossover" value={crossLabel} tone={velez.crossover === "bullish-cross" ? "bull" : velez.crossover === "bearish-cross" ? "bear" : "neutral"} />
        <StatBox label="CCI (5)" value={velez.cci != null ? velez.cci : "—"} sub={velez.cciSignal}
          tone={velez.cciSignal === "overbought" || velez.cciSignal === "oversold" ? "warn" : "neutral"} />
        <StatBox label="Elephant Bar" value={velez.elephant.isElephant ? (velez.elephant.direction === "bullish" ? "Bullish ▲" : "Bearish ▼") : "None"}
          sub={velez.elephant.isElephant ? `range ${velez.elephant.rangeRatio}x / vol ${velez.elephant.volRatio}x` : undefined}
          tone={velez.elephant.isElephant ? (velez.elephant.direction === "bullish" ? "bull" : "bear") : "neutral"} />
        <StatBox label="Opening Range" value={orLabel}
          sub={velez.openingRange.range ? `H ${velez.openingRange.range.high} / L ${velez.openingRange.range.low}` : undefined}
          tone={velez.openingRange.breakout === "long" ? "bull" : velez.openingRange.breakout === "short" ? "bear" : "neutral"} />
      </div>
      {velez.reasons.length > 0 && (
        <div className="mt-3 border-t border-[#1e2730] pt-2 space-y-1">
          {velez.reasons.map((r, i) => (<div key={i} className="text-[11px] text-gray-400">› {r}</div>))}
        </div>
      )}
    </div>
  );
}