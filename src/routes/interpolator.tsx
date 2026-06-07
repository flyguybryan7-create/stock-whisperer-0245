import { createFileRoute } from "@tanstack/react-router";
import FuturesSignalInterpolator from "@/components/FuturesSignalInterpolator";

export const Route = createFileRoute("/interpolator")({
  head: () => ({
    meta: [
      { title: "BRYANTRADE Futures Signal Interpolator" },
      { name: "description", content: "3-window interpolated futures signals with tunable weights and threshold." },
    ],
  }),
  component: () => <FuturesSignalInterpolator />,
});