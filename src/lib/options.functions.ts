import { createServerFn } from "@tanstack/react-start";
import { fetchOptionsActivitySnapshot } from "./options.server";

export const fetchOptionsActivity = createServerFn({ method: "POST" })
  .inputValidator((data: { symbols: string[] }) => {
    if (!data || !Array.isArray(data.symbols)) return { symbols: [] };
    const symbols = data.symbols
      .filter((s) => typeof s === "string")
      .map((s) => s.trim().toUpperCase())
      .filter((s) => s && /^[A-Z0-9.\-^]{1,10}$/.test(s))
      .slice(0, 20);
    return { symbols };
  })
  .handler(async ({ data }) => fetchOptionsActivitySnapshot(data.symbols));