const UA = "Mozilla/5.0 (compatible; BryanTrade/1.0)";

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
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const r = await fetch(
        `https://${host}/v7/finance/options/${encodeURIComponent(symbol)}`,
        { headers: { "User-Agent": UA, Accept: "application/json" } },
      );
      if (!r.ok) continue;
      const json: any = await r.json();
      const res = json?.optionChain?.result?.[0];
      const opt = res?.options?.[0];
      if (!opt) return null;
      const calls: any[] = opt.calls ?? [];
      const puts: any[] = opt.puts ?? [];
      const sum = (arr: any[], k: string) =>
        arr.reduce((s, x) => s + (Number(x?.[k]) || 0), 0);
      const callVolume = sum(calls, "volume");
      const putVolume = sum(puts, "volume");
      const callOi = sum(calls, "openInterest");
      const putOi = sum(puts, "openInterest");
      const totalVol = callVolume + putVolume;
      const totalOi = callOi + putOi;
      const pcRatio = callVolume > 0 ? putVolume / callVolume : null;
      let bias: OptionsActivity["bias"] = "NEUTRAL";
      if (callVolume > 50 && callVolume >= putVolume * 1.3) bias = "BULL";
      else if (putVolume > 50 && putVolume >= callVolume * 1.3) bias = "BEAR";
      const flowRatio = totalOi > 0 ? totalVol / totalOi : 0;
      const unusual = totalVol >= 500 && flowRatio >= 1.5;
      // intensity: how lopsided the flow is (0..1)
      const intensity =
        totalVol > 0
          ? Math.min(1, Math.abs(callVolume - putVolume) / totalVol)
          : 0;
      const expiry = opt.expirationDate
        ? new Date(opt.expirationDate * 1000).toISOString().slice(0, 10)
        : null;
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
        expiry,
      };
    } catch (e) {
      console.error("[options] error", symbol, host, e);
    }
  }
  return null;
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