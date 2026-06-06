import { createServerFn } from "@tanstack/react-start";
import { fetchAsiaSemisSnapshot, fetchMacroNewsSnapshot } from "./market-pulse.server";

export const fetchAsiaSemis = createServerFn({ method: "GET" }).handler(async () => {
  return fetchAsiaSemisSnapshot();
});

export const fetchMacroNews = createServerFn({ method: "GET" }).handler(async () => {
  return fetchMacroNewsSnapshot();
});