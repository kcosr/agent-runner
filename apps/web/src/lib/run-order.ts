import type { RunSummary } from "@task-runner/core/contracts/runs.js";

export function compareRunsByStartedAtDesc(left: RunSummary, right: RunSummary): number {
  const byStartedAt = right.startedAt.localeCompare(left.startedAt);
  if (byStartedAt !== 0) {
    return byStartedAt;
  }
  return left.runId.localeCompare(right.runId);
}

export function sortRunsByStartedAtDesc(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort(compareRunsByStartedAtDesc);
}
