const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36";

export type OptionsActivity = {
  symbol: string;
  callVolume: number;
  putVolume: number;
  callOi: number;
  putOi: number;
  pcRatio: number | null; // put/call volume
  bias: "BULL" | "BEAR" | "NEUTRAL";
  unusual: boolean; // total vol >= 1.5x total OI (heavy fresh flow)
  intensity: number; // 0..1 — used for flash strength
  expiry: string | null;
  // Highest-volume strike on each side (CBOE-listed via Nasdaq feed) +
  // share of that side's volume targeting that strike. Lets the UI show
  // e.g. "C $320 · 70%" meaning 70% of today's call volume is at $320.
  topCallStrike: number | null;
  topCallPct: number | null;
  topPutStrike: number | null;
  topPutPct: number | null;
};

export type OptionsActivityResponse = {
  items: Record<string, OptionsActivity>;
  asOf: number;
  error?: string;
};

async function fetchChain(symbol: string): Promise<OptionsActivity | null> {
  // Nasdaq's public option-chain endpoint — no auth, no crumb (Yahoo's
  // /v7/finance/options now requires a crumb cookie and returns Unauthorized).
  const url =
    `https://api.nasdaq.com/api/quote/${encodeURIComponent(symbol)}/option-chain` +
    `?assetclass=stocks&limit=2000&fromdate=all&todate=undefined` +
    `&excode=oprac&callput=callput&money=all&type=all`;
  try {
    const r = await fetch(url, {
      headers: {
        "User-Agent": UA,
        Accept: "application/json",
        "Accept-Language": "en-US,en;q=0.9",
      },
    });
    if (!r.ok) {
      console.error("[options] nasdaq status", symbol, r.status);
      return null;
    }
    const json: any = await r.json();
    const rows: any[] = json?.data?.table?.rows ?? [];
    if (!rows.length) return null;
    let callVolume = 0,
      putVolume = 0,
      callOi = 0,
      putOi = 0;
    let firstExpiry: string | null = null;
    // Per-strike call/put volume buckets to find the dominant target strike.
    const callByStrike = new Map<number, number>();
    const putByStrike = new Map<number, number>();
    const num = (v: any) => {
      if (v == null || v === "--" || v === "") return 0;
      const n = Number(String(v).replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    for (const row of rows) {
      const cv = num(row?.c_Volume);
      const pv = num(row?.p_Volume);
      callVolume += cv;
      putVolume += pv;
      callOi += num(row?.c_Openinterest);
      putOi += num(row?.p_Openinterest);
      const strike = num(row?.strike);
      if (strike > 0) {
        if (cv > 0) callByStrike.set(strike, (callByStrike.get(strike) ?? 0) + cv);
        if (pv > 0) putByStrike.set(strike, (putByStrike.get(strike) ?? 0) + pv);
      }
      if (!firstExpiry && row?.expiryDate) firstExpiry = String(row.expiryDate);
    }
    const pickTop = (m: Map<number, number>, total: number) => {
      if (total <= 0 || m.size === 0) return { strike: null as number | null, pct: null as number | null };
      let bestStrike = 0;
      let bestVol = 0;
      for (const [k, v] of m) if (v > bestVol) { bestVol = v; bestStrike = k; }
      return { strike: bestStrike || null, pct: bestStrike ? bestVol / total : null };
    };
    const topCall = pickTop(callByStrike, callVolume);
    const topPut = pickTop(putByStrike, putVolume);
    const totalVol = callVolume + putVolume;
    const totalOi = callOi + putOi;
    const pcRatio = callVolume > 0 ? putVolume / callVolume : null;
    let bias: OptionsActivity["bias"] = "NEUTRAL";
    if (callVolume > 50 && callVolume >= putVolume * 1.25) bias = "BULL";
    else if (putVolume > 50 && putVolume >= callVolume * 1.25) bias = "BEAR";
    const flowRatio = totalOi > 0 ? totalVol / totalOi : 0;
    const unusual = totalVol >= 300 && flowRatio >= 0.5;
    const intensity =
      totalVol > 0 ? Math.min(1, Math.abs(callVolume - putVolume) / totalVol) : 0;
    return {
      symbol,
      callVolume,
      putVolume,
      callOi,
      putOi,
      pcRatio,
      bias,
      unusual,
      intensity,
      expiry: firstExpiry,
      topCallStrike: topCall.strike,
      topCallPct: topCall.pct,
      topPutStrike: topPut.strike,
      topPutPct: topPut.pct,
    };
  } catch (e) {
    console.error("[options] error", symbol, e);
    return null;
  }
}

export async function fetchOptionsActivitySnapshot(
  symbols: string[],
): Promise<OptionsActivityResponse> {
  try {
    const list = symbols.slice(0, 20);
    const results = await Promise.all(list.map((s) => fetchChain(s)));
    const items: Record<string, OptionsActivity> = {};
    results.forEach((r, i) => {
      if (r) items[list[i]] = r;
    });
    return { items, asOf: Date.now() };
  } catch (error) {
    console.error("[options] snapshot failed", error);
    return { items: {}, asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
}