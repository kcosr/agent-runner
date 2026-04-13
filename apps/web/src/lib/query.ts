import { QueryClient } from "@tanstack/react-query";

export const runQueryKeys = {
  all: ["runs"] as const,
  list: () => [...runQueryKeys.all, "list"] as const,
  detail: (runId: string) => [...runQueryKeys.all, "detail", runId] as const,
};

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: 1,
      staleTime: 10_000,
      refetchOnWindowFocus: false,
    },
  },
});
