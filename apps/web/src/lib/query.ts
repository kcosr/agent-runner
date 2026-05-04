import { QueryClient } from "@tanstack/react-query";

interface RunListKeyOptions {
  includeArchived: boolean;
  runGroupId?: string | null;
}

export const runQueryKeys = {
  all: ["runs"] as const,
  lists: () => [...runQueryKeys.all, "list"] as const,
  list: ({ includeArchived, runGroupId = null }: RunListKeyOptions) =>
    [...runQueryKeys.lists(), { includeArchived, runGroupId }] as const,
  detail: (runId: string) => [...runQueryKeys.all, "detail", runId] as const,
  inputSurface: (agent: string, assignment: string, cwd?: string) =>
    [...runQueryKeys.all, "input-surface", { agent, assignment, cwd: cwd ?? null }] as const,
  definitions: ["definitions"] as const,
  agents: () => [...runQueryKeys.definitions, "agents"] as const,
  assignments: () => [...runQueryKeys.definitions, "assignments"] as const,
  launchers: () => [...runQueryKeys.definitions, "launchers"] as const,
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
