const UA = "Mozilla/5.0 (compatible; BryanTrade/1.0)";

export type OptionsFlow = {
  symbol: string;
  callVol: number;
  putVol: number;
  callDollar: number;
  putDollar: number;
  callOI: number;
  putOI: number;
  pcr: number | null; // put/call volume ratio
  side: "BUY" | "SELL" | "NEUTRAL"; // green/red/grey
  unusual: boolean; // volume > openInterest by meaningful margin
  score: number; // |callDollar - putDollar| (rank by absolute dollar imbalance)
  expiry: number | null;
};

export type OptionsFlowResponse = {
  flows: Record<string, OptionsFlow>;
  asOf: number;
  error?: string;
};

async function fetchOne(symbol: string): Promise<OptionsFlow | null> {
  for (const host of ["query1.finance.yahoo.com", "query2.finance.yahoo.com"]) {
    try {
      const res = await fetch(
        `https://${host}/v7/finance/options/${encodeURIComponent(symbol)}`,
        { headers: { "User-Agent": UA, Accept: "application/json" } },
      );
      if (!res.ok) continue;
      const json: any = await res.json();
      const chain = json?.optionChain?.result?.[0];
      const opt = chain?.options?.[0];
      if (!opt) continue;
      const calls: any[] = opt.calls ?? [];
      const puts: any[] = opt.puts ?? [];
      let callVol = 0, putVol = 0, callDollar = 0, putDollar = 0, callOI = 0, putOI = 0;
      for (const c of calls) {
        const v = Number(c.volume) || 0;
        const oi = Number(c.openInterest) || 0;
        const px = Number(c.lastPrice) || ((Number(c.bid) + Number(c.ask)) / 2) || 0;
        callVol += v; callOI += oi; callDollar += v * px * 100;
      }
      for (const p of puts) {
        const v = Number(p.volume) || 0;
        const oi = Number(p.openInterest) || 0;
        const px = Number(p.lastPrice) || ((Number(p.bid) + Number(p.ask)) / 2) || 0;
        putVol += v; putOI += oi; putDollar += v * px * 100;
      }
      const totalVol = callVol + putVol;
      const totalOI = callOI + putOI;
      const pcr = callVol > 0 ? putVol / callVol : null;
      // Side: dollar-weighted. Need >=20% imbalance to take a side.
      const totalDollar = callDollar + putDollar;
      let side: OptionsFlow["side"] = "NEUTRAL";
      if (totalDollar > 0) {
        const callShare = callDollar / totalDollar;
        if (callShare >= 0.60) side = "BUY";
        else if (callShare <= 0.40) side = "SELL";
      }
      // Unusual: today's volume > 1.5× total OI on the chain (aggressive bar)
      const unusual = totalOI > 0 ? totalVol > totalOI * 1.5 : totalVol > 5000;
      return {
        symbol,
        callVol, putVol, callDollar, putDollar, callOI, putOI,
        pcr, side, unusual,
        score: Math.abs(callDollar - putDollar),
        expiry: Number(opt.expirationDate) || null,
      };
    } catch (err) {
      console.error("[options-flow] error", symbol, host, err);
    }
  }
  return null;
}

export async function fetchOptionsFlowSnapshot(symbols: string[]): Promise<OptionsFlowResponse> {
  try {
    const top = symbols.slice(0, 20);
    const results = await Promise.all(top.map((s) => fetchOne(s)));
    const flows: Record<string, OptionsFlow> = {};
    for (const r of results) if (r) flows[r.symbol] = r;
    return { flows, asOf: Date.now() };
  } catch (error) {
    console.error("[options-flow] snapshot failed", error);
    return { flows: {}, asOf: Date.now(), error: "SERVICE_UNAVAILABLE" };
  }
}