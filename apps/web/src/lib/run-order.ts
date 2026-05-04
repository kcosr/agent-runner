import type { RunSummary } from "@task-runner/core/contracts/runs.js";

const DASHBOARD_SORT_FIELDS = ["startedAt", "updatedAt", "endedAt"] as const;
export type DashboardSortField = (typeof DASHBOARD_SORT_FIELDS)[number];

const DASHBOARD_SORT_DIRECTIONS = ["desc", "asc"] as const;
export type DashboardSortDirection = (typeof DASHBOARD_SORT_DIRECTIONS)[number];

export function isDashboardSortField(value: unknown): value is DashboardSortField {
  return typeof value === "string" && DASHBOARD_SORT_FIELDS.includes(value as DashboardSortField);
}

export function isDashboardSortDirection(value: unknown): value is DashboardSortDirection {
  return (
    typeof value === "string" && DASHBOARD_SORT_DIRECTIONS.includes(value as DashboardSortDirection)
  );
}

function compareTimestamp(left: string, right: string, direction: DashboardSortDirection): number {
  return direction === "desc" ? right.localeCompare(left) : left.localeCompare(right);
}

function compareRunsByStartedAtDesc(left: RunSummary, right: RunSummary): number {
  const byStartedAt = right.startedAt.localeCompare(left.startedAt);
  if (byStartedAt !== 0) {
    return byStartedAt;
  }
  return left.runId.localeCompare(right.runId);
}

export function sortRunsByStartedAtDesc(runs: RunSummary[]): RunSummary[] {
  return [...runs].sort(compareRunsByStartedAtDesc);
}

function compareRunsByStartedAt(
  left: RunSummary,
  right: RunSummary,
  direction: DashboardSortDirection,
): number {
  const byStartedAt = compareTimestamp(left.startedAt, right.startedAt, direction);
  if (byStartedAt !== 0) {
    return byStartedAt;
  }
  return left.runId.localeCompare(right.runId);
}

function compareRunsByUpdatedAt(
  left: RunSummary,
  right: RunSummary,
  direction: DashboardSortDirection,
): number {
  const byUpdatedAt = compareTimestamp(left.updatedAt, right.updatedAt, direction);
  if (byUpdatedAt !== 0) {
    return byUpdatedAt;
  }
  return compareRunsByStartedAtDesc(left, right);
}

function compareRunsByEndedAt(
  left: RunSummary,
  right: RunSummary,
  direction: DashboardSortDirection,
): number {
  if (left.endedAt === null && right.endedAt === null) {
    return compareRunsByUpdatedAt(left, right, "desc");
  }
  if (left.endedAt === null) {
    return 1;
  }
  if (right.endedAt === null) {
    return -1;
  }
  const byEndedAt = compareTimestamp(left.endedAt, right.endedAt, direction);
  if (byEndedAt !== 0) {
    return byEndedAt;
  }
  return compareRunsByUpdatedAt(left, right, "desc");
}

export function createRunComparator(
  sortField: DashboardSortField,
  sortDirection: DashboardSortDirection,
): (left: RunSummary, right: RunSummary) => number {
  switch (sortField) {
    case "startedAt":
      return (left, right) => compareRunsByStartedAt(left, right, sortDirection);
    case "updatedAt":
      return (left, right) => compareRunsByUpdatedAt(left, right, sortDirection);
    case "endedAt":
      return (left, right) => compareRunsByEndedAt(left, right, sortDirection);
  }
}

function compareRunsByPinned(
  left: Pick<RunSummary, "pinned">,
  right: Pick<RunSummary, "pinned">,
): number {
  if (left.pinned === right.pinned) {
    return 0;
  }
  return left.pinned ? -1 : 1;
}

function compareRunsByPinnedThen(
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
