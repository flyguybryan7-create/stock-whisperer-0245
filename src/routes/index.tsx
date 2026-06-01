import { createFileRoute } from "@tanstack/react-router";
import TradingPlatform from "@/components/TradingPlatform";

export const Route = createFileRoute("/")({
  head: () => ({
    meta: [
      { title: "BryanTrade Pro Terminal" },
      { name: "description", content: "Pro trading terminal with AI signals, RSI, MACD, Bollinger Bands and price alerts." },
      { property: "og:title", content: "BryanTrade Pro Terminal" },
      { property: "og:description", content: "Pro trading terminal with AI signals, RSI, MACD, Bollinger Bands and price alerts." },
    ],
  }),
  component: Index,
});

function Index() {
  return <TradingPlatform />;
}
