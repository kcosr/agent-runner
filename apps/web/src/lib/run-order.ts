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

export function compareRunsByPinned(
  left: Pick<RunSummary, "pinned">,
  right: Pick<RunSummary, "pinned">,
): number {
  if (left.pinned === right.pinned) {
    return 0;
  }
  return left.pinned ? -1 : 1;
}

export function compareRunsByPinnedThen(
  left: RunSummary,
  right: RunSummary,
  compare: (left: RunSummary, right: RunSummary) => number,
): number {
  const byPinned = compareRunsByPinned(left, right);
  if (byPinned !== 0) {
    return byPinned;
  }
  return compare(left, right);
}

export function sortRunsWithPinnedFirst(
  runs: RunSummary[],
  compare: (left: RunSummary, right: RunSummary) => number,
): RunSummary[] {
  return [...runs].sort((left, right) => compareRunsByPinnedThen(left, right, compare));
}
