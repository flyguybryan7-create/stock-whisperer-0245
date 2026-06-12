import { createServerFn } from "@tanstack/react-start";
import {
  fetchAsiaSemisSnapshot,
  fetchFastPulseSnapshot,
  fetchMacroNewsSnapshot,
  fetchMarketPulseSnapshot,
  fetchSemisPulseSnapshot,
  fetchGlobalSemiIndexSnapshot,
  fetchSemiRiskSentimentSnapshot,
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

export const fetchFastPulse = createServerFn({ method: "GET" }).handler(async () => {
  return fetchFastPulseSnapshot();
});

export const fetchSemisPulse = createServerFn({ method: "GET" }).handler(async () => {
  return fetchSemisPulseSnapshot();
});

export const fetchGlobalSemiIndex = createServerFn({ method: "GET" }).handler(async () => {
  return fetchGlobalSemiIndexSnapshot();
});

export const fetchSemiRiskSentiment = createServerFn({ method: "GET" }).handler(async () => {
  return fetchSemiRiskSentimentSnapshot();
});