/**
 * Magnet-strike selection for the Options Flow Magnet.
 *
 * The magnet must be picked from the SAME near-the-money strike window the
 * ladder renders. Scanning the entire chain lets deep out-of-the-money junk
 * (e.g. a $40 put on a $190 stock, usually a spread leg or a rolled hedge)
 * win the "target strike" callout, which is not a real price target.
 */
export type MagnetRung = {
  strike: number;
  callVol: number;
  putVol: number;
  callOi?: number;
  putOi?: number;
};

export type Magnet = { strike: number; volume: number } | null;

export function magnetsFromRungs(
  rungs: MagnetRung[],
  source: "volume" | "oi" = "volume",
): { call: Magnet; put: Magnet } {
  let call: Magnet = null;
  let put: Magnet = null;
  for (const r of rungs) {
    const c = source === "oi" ? (r.callOi ?? r.callVol) : r.callVol;
    const p = source === "oi" ? (r.putOi ?? r.putVol) : r.putVol;
    if (c > (call?.volume ?? 0)) call = { strike: r.strike, volume: c };
    if (p > (put?.volume ?? 0)) put = { strike: r.strike, volume: p };
  }
  return { call, put };
}
