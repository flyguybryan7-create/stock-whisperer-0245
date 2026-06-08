import { createFileRoute } from "@tanstack/react-router";
import { SignalInterpolator } from "@/components/FuturesSignalInterpolator";

type Search = { symbols?: string; prices?: string };

export const Route = createFileRoute("/interpolator/stocks")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    symbols: typeof s.symbols === "string" ? s.symbols : undefined,
    prices: typeof s.prices === "string" ? s.prices : undefined,
  }),
  head: () => ({
    meta: [
      { title: "BRYANTRADE Stocks Signal Interpolator" },
      { name: "description", content: "3-window interpolated stock signals." },
    ],
  }),
  component: StocksInterpolatorPage,
});

function StocksInterpolatorPage() {
  const { symbols, prices } = Route.useSearch();
  const symList: string[] = (symbols ?? "")
    .split(",")
    .map((s: string) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);
  const priceList: number[] = (prices ?? "").split(",").map((p: string) => parseFloat(p));
  const tickers = symList.length
    ? symList.map((ticker: string, i: number) => ({
        ticker,
        basePrice: Number.isFinite(priceList[i]) && priceList[i] > 0 ? priceList[i] : 100,
      }))
    : [{ ticker: "AAPL", basePrice: 100 }];
  return (
    <SignalInterpolator
      tickers={tickers}
      title="STOCKS INTERPOLATOR"
      subtitle="BRYANTRADE · STOCKS MODULE"
      defaultActive={tickers.map((t: { ticker: string }) => t.ticker)}
    />
  );
}