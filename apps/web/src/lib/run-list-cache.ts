import type { QueryClient, QueryKey } from "@tanstack/react-query";
import type { RunSummary } from "@task-runner/core/contracts/runs.js";
import { runQueryKeys } from "./query.js";
import { sortRunsByStartedAtDesc } from "./run-order.js";

export interface RunListQueryMetadata {
  includeArchived: boolean;
  runGroupId: string | null;
}

export function runListQueryMetadata(queryKey: QueryKey): RunListQueryMetadata {
  return queryKey[queryKey.length - 1] as RunListQueryMetadata;
}

export function runBelongsInListCache(
  summary: RunSummary,
  metadata: RunListQueryMetadata,
): boolean {
  return (
    (metadata.includeArchived || summary.archivedAt === null) &&
    (metadata.runGroupId === null || summary.runGroupId === metadata.runGroupId)
  );
}

export function removeRunFromListCache(
  current: RunSummary[] | undefined,
  runId: string,
): RunSummary[] | undefined {
  if (!current) {
    return current;
  }
  const next = current.filter((run) => run.runId !== runId);
  return next.length === current.length ? current : next;
}

function setRunSummaryInListCache(
  current: RunSummary[] | undefined,
  summary: RunSummary,
  metadata: RunListQueryMetadata,
  upsert: boolean,
): RunSummary[] | undefined {
  if (!current) {
    return current;
  }
  if (!runBelongsInListCache(summary, metadata)) {
    return removeRunFromListCache(current, summary.runId);
  }

  const existingIndex = current.findIndex((run) => run.runId === summary.runId);
  if (existingIndex === -1) {
    return upsert ? sortRunsByStartedAtDesc([...current, summary]) : current;
  }

  const next = [...current];
  next[existingIndex] = summary;
  return next;
}

export function upsertRunSummaryInListCache(
  current: RunSummary[] | undefined,
  summary: RunSummary,
  metadata: RunListQueryMetadata,
): RunSummary[] | undefined {
  return setRunSummaryInListCache(current, summary, metadata, true);
}

export function updateRunSummaryInListCache(
  current: RunSummary[] | undefined,
  runId: string,
  metadata: RunListQueryMetadata,
  update: (run: RunSummary) => RunSummary,
): RunSummary[] | undefined {
  if (!current) {
    return current;
  }

  const existing = current.find((run) => run.runId === runId);
  return existing ? setRunSummaryInListCache(current, update(existing), metadata, false) : current;
}

export function updateRunListCacheQueries(
  queryClient: QueryClient,
  update: (
    current: RunSummary[] | undefined,
    metadata: RunListQueryMetadata,
  ) => RunSummary[] | undefined,
): void {
  const queries = queryClient.getQueryCache().findAll({ queryKey: runQueryKeys.lists() });
  for (const query of queries) {
    const queryKey = query.queryKey;
    queryClient.setQueryData<RunSummary[] | undefined>(queryKey, (current) =>
      update(current, runListQueryMetadata(queryKey)),
    );
  }
}
