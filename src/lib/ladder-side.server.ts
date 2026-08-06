/**
 * Aggressor classification for option contract volume.
 *
 * A chain snapshot gives us bid / ask / last per contract, not a trade tape.
 * The Lee-Ready tick rule applied to the snapshot is the standard proxy:
 *   last at (or above) the ask  -> buyer-initiated  (contracts BOUGHT)
 *   last at (or below) the bid  -> seller-initiated (contracts SOLD/written)
 *   inside the spread           -> split proportionally to where last sits
 *
 * This is an estimate, not exchange-reported buy/sell, so callers should
 * label it as such in the UI.
 */
export type AggressorSplit = { buy: number; sell: number };

export function splitByAggressor(
  volume: number,
  last: number,
  bid: number,
  ask: number,
): AggressorSplit {
  const v = Number.isFinite(volume) && volume > 0 ? volume : 0;
  if (v === 0) return { buy: 0, sell: 0 };
  const b = Number.isFinite(bid) && bid > 0 ? bid : 0;
  const a = Number.isFinite(ask) && ask > 0 ? ask : 0;
  const l = Number.isFinite(last) && last > 0 ? last : 0;
  if (!l || !b || !a || a <= b) return { buy: v / 2, sell: v / 2 };
  if (l >= a) return { buy: v, sell: 0 };
  if (l <= b) return { buy: 0, sell: v };
  const frac = Math.min(1, Math.max(0, (l - b) / (a - b)));
  return { buy: v * frac, sell: v * (1 - frac) };
}

export function sumAggressor(
  rungs: { callBuyVol?: number; callSellVol?: number; putBuyVol?: number; putSellVol?: number }[],
) {
  let callBuyVolume = 0, callSellVolume = 0, putBuyVolume = 0, putSellVolume = 0;
  for (const r of rungs) {
    callBuyVolume += r.callBuyVol ?? 0;
    callSellVolume += r.callSellVol ?? 0;
    putBuyVolume += r.putBuyVol ?? 0;
    putSellVolume += r.putSellVol ?? 0;
  }
  return {
    callBuyVolume: Math.round(callBuyVolume),
    callSellVolume: Math.round(callSellVolume),
    putBuyVolume: Math.round(putBuyVolume),
    putSellVolume: Math.round(putSellVolume),
  };
}
