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
    const num = (v: any) => {
      if (v == null || v === "--" || v === "") return 0;
      const n = Number(String(v).replace(/,/g, ""));
      return Number.isFinite(n) ? n : 0;
    };
    for (const row of rows) {
      callVolume += num(row?.c_Volume);
      putVolume += num(row?.p_Volume);
      callOi += num(row?.c_Openinterest);
      putOi += num(row?.p_Openinterest);
      if (!firstExpiry && row?.expiryDate) firstExpiry = String(row.expiryDate);
    }
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