import { createFileRoute } from "@tanstack/react-router";
import { SignalInterpolator } from "@/components/FuturesSignalInterpolator";

type Search = { symbols?: string };

export const Route = createFileRoute("/interpolator/stocks")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    symbols: typeof s.symbols === "string" ? s.symbols : undefined,
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
  const { symbols } = Route.useSearch();
  const symList: string[] = (symbols ?? "")
    .split(",")
    .map((s: string) => s.trim().toUpperCase())
    .filter(Boolean)
    .slice(0, 20);
  const tickers = symList.length
    ? symList.map((ticker: string) => ({ ticker }))
    : [{ ticker: "AAPL" }];
  return (
    <SignalInterpolator
      tickers={tickers}
      title="STOCKS INTERPOLATOR"
      subtitle="BRYANTRADE · STOCKS MODULE"
      defaultActive={tickers.map((t: { ticker: string }) => t.ticker)}
    />
  );
}