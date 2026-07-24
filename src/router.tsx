import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { routeTree } from "./routeTree.gen";

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        throwOnError: false,
        retry: (failureCount, error) => {
          const message = error instanceof Error ? error.message : String(error);
          if (message.includes("Failed to fetch") || message.includes("aborted") || message.includes("ERR_ABORTED")) {
            return failureCount < 1;
          }
          return failureCount < 2;
        },
        refetchOnWindowFocus: false,
      },
      mutations: {
        throwOnError: false,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreloadStaleTime: 0,
  });

  return router;
};
