import { createServerFn } from "@tanstack/react-start";
import { fetchOptionsFlowSnapshot } from "./options-flow.server";

export const fetchOptionsFlow = createServerFn({ method: "POST" })
  .inputValidator((data: { symbols: string[] }) => {
    if (!data || !Array.isArray(data.symbols)) throw new Error("symbols required");
    const cleaned = data.symbols
      .filter((s): s is string => typeof s === "string")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => /^[A-Z.\-]{1,8}$/.test(s))
      .slice(0, 20);
    return { symbols: cleaned };
  })
  .handler(async ({ data }) => {
    return fetchOptionsFlowSnapshot(data.symbols);
  });