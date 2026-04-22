import { QueryClient } from "@tanstack/react-query";

export const runQueryKeys = {
  all: ["runs"] as const,
  lists: () => [...runQueryKeys.all, "list"] as const,
  list: (familyRootRunId: string | null = null) =>
    [...runQueryKeys.lists(), { familyRootRunId }] as const,
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
