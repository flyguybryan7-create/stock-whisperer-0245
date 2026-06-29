/**
 * Gap-and-Trap detector.
 *
 * Heuristic for "gap up + institutional sell-off" (MU-style bull trap) and
 * the inverse "gap down + short-squeeze trap". Uses only intraday bars and
 * the session VWAP we already pull from Schwab — no L2/order-flow needed.
 *
 * Rules:
 *   gapPct       = (todayOpen - yesterdayClose) / yesterdayClose
 *   firstWindow  = first 30 minutes of the regular session (09:30-10:00 ET)
 *   reversalDown = high(firstWindow) > todayOpen * 1.005 AND
 *                  currentClose < vwap AND currentClose < todayOpen
 *   reversalUp   = low(firstWindow)  < todayOpen * 0.995 AND
 *                  currentClose > vwap AND currentClose > todayOpen
 *
 *   gapPct >= +3% && reversalDown -> BULL_TRAP (red)
 *   gapPct <= -3% && reversalUp   -> BEAR_TRAP (green)
 */

export type TrapBar = { t: number; open: number; high: number; low: number; close: number; volume: number };

export type TrapResult = {
  kind: "BULL_TRAP" | "BEAR_TRAP" | null;
  gapPct: number | null;
  reason: string;
  triggeredAt: number | null;
};

const NULL: TrapResult = { kind: null, gapPct: null, reason: "no signal", triggeredAt: null };

function etDateKey(unixSec: number): string {
  // Group bars by US Eastern calendar day so we can isolate "today"/"yesterday".
  const d = new Date(unixSec * 1000);
  const fmt = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York", year: "numeric", month: "2-digit", day: "2-digit" });
  return fmt.format(d); // "YYYY-MM-DD"
}

function etMinutesSinceMidnight(unixSec: number): number {
  const d = new Date(unixSec * 1000);
  const fmt = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false });
  const parts = fmt.formatToParts(d);
  const h = Number(parts.find((p) => p.type === "hour")?.value ?? "0");
  const m = Number(parts.find((p) => p.type === "minute")?.value ?? "0");
  return h * 60 + m;
}

export function detectTrap(bars: TrapBar[], vwap: number | null): TrapResult {
  if (!Array.isArray(bars) || bars.length < 10) return NULL;

  // Group by ET date.
  const byDay = new Map<string, TrapBar[]>();
  for (const b of bars) {
    if (!Number.isFinite(b?.t) || !Number.isFinite(b?.close)) continue;
    const k = etDateKey(b.t);
    const list = byDay.get(k) ?? [];
    list.push(b);
    byDay.set(k, list);
  }
  const days = [...byDay.keys()].sort();
  if (days.length < 2) return NULL;

  const todayKey = days[days.length - 1];
  const yKey = days[days.length - 2];
  const today = (byDay.get(todayKey) ?? []).slice().sort((a, b) => a.t - b.t);
  const yesterday = (byDay.get(yKey) ?? []).slice().sort((a, b) => a.t - b.t);
  if (today.length < 3 || yesterday.length < 3) return NULL;

  // Use the regular-session open (09:30 ET) and yesterday's regular-session close (16:00 ET).
  const todayReg = today.filter((b) => {
    const m = etMinutesSinceMidnight(b.t);
    return m >= 9 * 60 + 30 && m <= 16 * 60;
  });
  const yReg = yesterday.filter((b) => {
    const m = etMinutesSinceMidnight(b.t);
    return m >= 9 * 60 + 30 && m <= 16 * 60;
  });
  if (todayReg.length < 2 || yReg.length === 0) return NULL;

  const todayOpen = todayReg[0].open;
  const yClose = yReg[yReg.length - 1].close;
  if (!Number.isFinite(todayOpen) || !Number.isFinite(yClose) || yClose <= 0) return NULL;
  const gapPct = (todayOpen - yClose) / yClose;

  // First 30 minutes window: 09:30 → 10:00 ET.
  const firstWindow = todayReg.filter((b) => etMinutesSinceMidnight(b.t) <= 10 * 60);
  if (firstWindow.length === 0) return { ...NULL, gapPct };
  const firstHigh = Math.max(...firstWindow.map((b) => b.high));
  const firstLow = Math.min(...firstWindow.map((b) => b.low));
  const last = todayReg[todayReg.length - 1];
  const currentClose = last.close;
  // Synthesize a session VWAP from today's regular bars when Schwab's VWAP
  // isn't available — so trap detection works for every symbol, not just
  // Schwab-quoted ones.
  let v: number | null = Number.isFinite(vwap) ? (vwap as number) : null;
  if (v == null) {
    let pv = 0, vv = 0;
    for (const b of todayReg) {
      const typ = (b.high + b.low + b.close) / 3;
      const vol = Math.max(0, b.volume || 0);
      pv += typ * vol; vv += vol;
    }
    if (vv > 0) v = pv / vv;
  }

  // Loosened gap thresholds (1.5% / -1.5%) and lighter rejection criteria so
  // the "gap up, hedge funds dump into retail" pattern actually fires.
  const todayHigh = Math.max(...todayReg.map((b) => b.high));
  const todayLow = Math.min(...todayReg.map((b) => b.low));

  if (gapPct >= 0.015 && v != null) {
    const rejected = firstHigh > todayOpen * 1.003 && currentClose < v && currentClose < todayOpen;
    if (rejected) {
      return {
        kind: "BULL_TRAP", gapPct,
        reason: `Gap +${(gapPct * 100).toFixed(1)}% then rejected: high $${firstHigh.toFixed(2)} → now $${currentClose.toFixed(2)} below VWAP $${v.toFixed(2)}.`,
        triggeredAt: last.t,
      };
    }
  }
  if (gapPct <= -0.015 && v != null) {
    const reclaimed = firstLow < todayOpen * 0.997 && currentClose > v && currentClose > todayOpen;
    if (reclaimed) {
      return {
        kind: "BEAR_TRAP", gapPct,
        reason: `Gap ${(gapPct * 100).toFixed(1)}% then reclaimed: low $${firstLow.toFixed(2)} → now $${currentClose.toFixed(2)} above VWAP $${v.toFixed(2)}.`,
        triggeredAt: last.t,
      };
    }
  }

  // Intraday VWAP-rejection trap (no gap required): a new session high that
  // gets dumped back below VWAP on rising volume. Catches mid-day institutional
  // distribution like MU's earnings-day reversal.
  if (v != null && todayReg.length >= 10) {
    const avgVol = todayReg.slice(0, -3).reduce((s, b) => s + (b.volume || 0), 0) / Math.max(1, todayReg.length - 3);
    const recentVol = todayReg.slice(-3).reduce((s, b) => s + (b.volume || 0), 0) / 3;
    const heavy = avgVol > 0 && recentVol > avgVol * 1.3;
    if (heavy && currentClose < v && todayHigh > v * 1.01 && currentClose < todayHigh * 0.99) {
      return {
        kind: "BULL_TRAP", gapPct,
        reason: `Intraday distribution: HOD $${todayHigh.toFixed(2)} dumped to $${currentClose.toFixed(2)} below VWAP $${v.toFixed(2)} on ${(recentVol / avgVol).toFixed(1)}× volume.`,
        triggeredAt: last.t,
      };
    }
    if (heavy && currentClose > v && todayLow < v * 0.99 && currentClose > todayLow * 1.01) {
      return {
        kind: "BEAR_TRAP", gapPct,
        reason: `Intraday squeeze: LOD $${todayLow.toFixed(2)} reclaimed to $${currentClose.toFixed(2)} above VWAP $${v.toFixed(2)} on ${(recentVol / avgVol).toFixed(1)}× volume.`,
        triggeredAt: last.t,
      };
    }
  }
  return { ...NULL, gapPct };
}