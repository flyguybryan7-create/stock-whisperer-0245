import { createServerFn } from "@tanstack/react-start";
import {
  fetchAsiaSemisSnapshot,
  fetchMacroNewsSnapshot,
  fetchMarketPulseSnapshot,
} from "./market-pulse.server";

export const fetchAsiaSemis = createServerFn({ method: "GET" }).handler(async () => {
  return fetchAsiaSemisSnapshot();
});

export const fetchMacroNews = createServerFn({ method: "GET" }).handler(async () => {
  return fetchMacroNewsSnapshot();
});

export const fetchMarketPulse = createServerFn({ method: "GET" }).handler(async () => {
  return fetchMarketPulseSnapshot();
});