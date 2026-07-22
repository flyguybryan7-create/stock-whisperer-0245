import type { SchwabOptionsLadder, SchwabLadderRung } from "./schwab.functions";

export function buildLadderFromChain(sym: string, json: any, expiryIndex = 0, _snapshotScope = "default"): SchwabOptionsLadder | null {
  const callMap = json?.callExpDateMap ?? {};
  const putMap = json?.putExpDateMap ?? {};
  const spot = Number.isFinite(json?.underlyingPrice) ? Number(json.underlyingPrice) : null;
  const allKeys = Array.from(new Set([...Object.keys(callMap), ...Object.keys(putMap)])).sort();
  const futureKeys = allKeys
    .map((k) => ({ key: k, dte: Number(k.split(":")[1]) }))
    .filter((x) => Number.isFinite(x.dte) && x.dte >= 0)
    .sort((a, b) => a.dte - b.dte);
  if (!futureKeys.length) return null;
  const idx = Math.min(Math.max(0, expiryIndex), futureKeys.length - 1);
  const chosen = futureKeys[idx].key;
  const [expiry, dteStr] = chosen.split(":");
  const dte = Number(dteStr);
  const cExp = callMap?.[chosen] ?? {};
  const pExp = putMap?.[chosen] ?? {};
  const strikes = new Set<number>();
  for (const k of Object.keys(cExp)) strikes.add(Number(k));
  for (const k of Object.keys(pExp)) strikes.add(Number(k));
  const rungs: SchwabLadderRung[] = [];
  let callTot = 0, putTot = 0;
  let magC: { strike: number; volume: number } | null = null;
  let magP: { strike: number; volume: number } | null = null;
  for (const strike of Array.from(strikes).sort((a, b) => a - b)) {
    const c = cExp[strike];
    const p = pExp[strike];
    const cv = Array.isArray(c) && c[0]?.totalVolume ? Number(c[0].totalVolume) : 0;
    const pv = Array.isArray(p) && p[0]?.totalVolume ? Number(p[0].totalVolume) : 0;
    const coi = Array.isArray(c) && c[0]?.openInterest ? Number(c[0].openInterest) : 0;
    const poi = Array.isArray(p) && p[0]?.openInterest ? Number(p[0].openInterest) : 0;
    callTot += cv; putTot += pv;
    if (cv > (magC?.volume ?? 0)) magC = { strike, volume: cv };
    if (pv > (magP?.volume ?? 0)) magP = { strike, volume: pv };
    rungs.push({ strike, callVol: cv, putVol: pv, callOi: coi, putOi: poi });
  }
  let displayRungs = rungs;
  let trimmed = displayRungs;
  if (spot && spot > 0) {
    const lo = spot * 0.75, hi = spot * 1.25;
    trimmed = displayRungs.filter((r) => r.strike >= lo && r.strike <= hi);
    if (trimmed.length < 8) {
      trimmed = [...displayRungs]
        .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
        .slice(0, 20)
        .sort((a, b) => a.strike - b.strike);
    }
  }
  const d = new Date(expiry + "T00:00:00");
  const label = Number.isNaN(d.getTime()) ? expiry
    : `${d.toLocaleString("en-US", { month: "short" })} ${d.getDate()}`;
  const alternateExpiries = futureKeys.slice(0, 8).map(({ key, dte: kd }) => {
    const exp = key.split(":")[0];
    const dd = new Date(exp + "T00:00:00");
    // Sum same-day volume across every strike so the dropdown can show
    // which expiries actually have flow.
    let vol = 0;
    const cE = callMap?.[key] ?? {};
    const pE = putMap?.[key] ?? {};
    for (const arr of Object.values(cE) as any[]) {
      const v = Array.isArray(arr) && arr[0]?.totalVolume ? Number(arr[0].totalVolume) : 0;
      if (Number.isFinite(v)) vol += v;
    }
    for (const arr of Object.values(pE) as any[]) {
      const v = Array.isArray(arr) && arr[0]?.totalVolume ? Number(arr[0].totalVolume) : 0;
      if (Number.isFinite(v)) vol += v;
    }
    return {
      expiry: exp,
      dte: Number.isFinite(kd) ? kd : null,
      label: Number.isNaN(dd.getTime()) ? exp : `${dd.toLocaleString("en-US", { month: "short" })} ${dd.getDate()}`,
      volume: vol,
    };
  });
  let source: "volume" | "oi" = "volume";
  let effCallTot = callTot;
  let effPutTot = putTot;
  let effMagC = magC;
  let effMagP = magP;
  if (callTot === 0 && putTot === 0) {
    source = "oi";
    displayRungs = rungs.map((r) => ({ ...r, callVol: r.callOi, putVol: r.putOi }));
    trimmed = displayRungs;
    effCallTot = 0;
    effPutTot = 0;
    effMagC = null;
    effMagP = null;
    for (const r of rungs) {
      effCallTot += r.callOi;
      effPutTot += r.putOi;
      if (r.callOi > (effMagC?.volume ?? 0)) effMagC = { strike: r.strike, volume: r.callOi };
      if (r.putOi > (effMagP?.volume ?? 0)) effMagP = { strike: r.strike, volume: r.putOi };
    }
    if (effCallTot === 0 && effPutTot === 0) return null;
    if (spot && spot > 0) {
      const lo = spot * 0.75, hi = spot * 1.25;
      trimmed = displayRungs.filter((r) => r.strike >= lo && r.strike <= hi);
      if (trimmed.length < 8) {
        trimmed = [...displayRungs]
          .sort((a, b) => Math.abs(a.strike - spot) - Math.abs(b.strike - spot))
          .slice(0, 20)
          .sort((a, b) => a.strike - b.strike);
      }
    }
  }
  return {
    symbol: sym,
    expiry,
    dte: Number.isFinite(dte) ? dte : null,
    label,
    hasWeeklies: Number.isFinite(dte) && dte <= 10,
    spot,
    callVolume: effCallTot,
    putVolume: effPutTot,
    magnetCall: effMagC ? { strike: effMagC.strike, volume: effMagC.volume, pct: effCallTot > 0 ? effMagC.volume / effCallTot : 0 } : null,
    magnetPut: effMagP ? { strike: effMagP.strike, volume: effMagP.volume, pct: effPutTot > 0 ? effMagP.volume / effPutTot : 0 } : null,
    ladder: trimmed,
    alternateExpiries,
    source,
    flowWindowSeconds: null,
    asOf: new Date().toISOString(),
  };
}