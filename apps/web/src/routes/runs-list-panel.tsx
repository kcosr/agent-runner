import type { RunSummary } from "@kcosr/agent-runner-core/contracts/runs.js";
import type { UseQueryResult } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { EmptyPanel } from "../components/empty-states.js";
import { RunCard } from "../components/run-card.js";
import { RunRow } from "../components/run-row.js";
import { isUnauthorizedError } from "../lib/api-client.js";
import type { DashboardSortField, DashboardStructuredFilters } from "../lib/settings.js";
import type {
  DashboardListStatusCount,
  DashboardListStatusFilter,
  RunActionPending,
} from "./use-runs-dashboard-state.js";

const LIST_LOADING_SKELETON_KEYS = [
  "first",
  "second",
  "third",
  "fourth",
  "fifth",
  "sixth",
  "seventh",
  "eighth",
] as const;

const MOBILE_LIST_CARD_MEDIA_QUERY = "(max-width: 900px)";

function mediaQueryMatches(query: string) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return false;
  }
  return window.matchMedia(query).matches;
}

function useMediaQuery(query: string) {
  const [matches, setMatches] = useState(() => mediaQueryMatches(query));

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }

    const mediaQuery = window.matchMedia(query);
    const update = () => setMatches(mediaQuery.matches);
    update();

    if (typeof mediaQuery.addEventListener === "function") {
      mediaQuery.addEventListener("change", update);
      return () => mediaQuery.removeEventListener("change", update);
    }

    mediaQuery.addListener(update);
    return () => mediaQuery.removeListener(update);
  }, [query]);

  return matches;
}

export function RunsListPanel({
  actionPending,
  hasActiveStructuredFilters,
  listRows,
  listStatusCounts,
  listStatusFilter,
  onListStatusFilterChange,
  onOpenNote,
  onRequestActionMenu,
  onResetFilters,
  onSelectRun,
  onSetNote,
  onSetPinned,
  onStructuredFilterToggle,
  runs,
  runsQuery,
  searchValue,
  selectedRunId,
  sortField,
  structuredFilters,
  visibleRuns,
}: {
  actionPending?: RunActionPending;
  hasActiveStructuredFilters: boolean;
  listRows: RunSummary[];
  listStatusCounts: DashboardListStatusCount[];
  listStatusFilter: DashboardListStatusFilter | null;
  onListStatusFilterChange: (status: DashboardListStatusFilter | null) => void;
  onOpenNote: (runId: string) => void;
  onRequestActionMenu: (runId: string, point: { clientX: number; clientY: number }) => void;
  onResetFilters: () => void;
  onSelectRun: (runId: string) => void;
  onSetNote: (runId: string, note: string | null) => Promise<void>;
  onSetPinned: (runId: string, pinned: boolean) => Promise<void>;
  onStructuredFilterToggle: (key: keyof DashboardStructuredFilters, value: string) => void;
  runs: RunSummary[];
  runsQuery: UseQueryResult<RunSummary[], Error>;
  searchValue: string;
  selectedRunId?: string;
  sortField: DashboardSortField;
  structuredFilters: DashboardStructuredFilters;
  visibleRuns: RunSummary[];
}) {
  const navigate = useNavigate();
  const mobileListCards = useMediaQuery(MOBILE_LIST_CARD_MEDIA_QUERY);

  if (runsQuery.isPending) {
    return (
      <section aria-label="Runs list loading" className="runs-list-region runs-list-region--state">
        {LIST_LOADING_SKELETON_KEYS.map((key) => (
          <div className="run-row run-row--skeleton" key={`list-skeleton-${key}`}>
            <div className="skeleton-line skeleton-line--short" />
            <div className="skeleton-line skeleton-line--medium" />
            <div className="skeleton-line skeleton-line--short" />
          </div>
        ))}
      </section>
    );
  }

  if (runsQuery.isError) {
    if (isUnauthorizedError(runsQuery.error)) {
      return (
        <section className="runs-list-region runs-list-region--state">
          <EmptyPanel
            action={
              <button
                className="btn btn-primary"
                onClick={() => void navigate({ to: "/settings/general" })}
                type="button"
              >
                Open Settings
              </button>
            }
            body="Enter the daemon token in Settings to load runs from this daemon."
            title="Daemon token required"
          />
        </section>
      );
    }

    return (
      <section className="runs-list-region runs-list-region--state">
        <EmptyPanel
          action={
            <button className="btn" onClick={() => void runsQuery.refetch()} type="button">
              Retry list load
            </button>
          }
          body={runsQuery.error.message}
          title="Run list failed to load"
        />
      </section>
    );
  }

  if (visibleRuns.length === 0) {
    const hasSearch = searchValue.trim().length > 0;
    const emptyTitle = runs.length === 0 ? "No runs yet" : "No matching runs";
    const emptyBody =
      runs.length === 0
        ? "No runs are available yet. Start or initialize a run, then refresh this list."
        : hasActiveStructuredFilters && hasSearch
          ? "Current filters and search are hiding every run. Clear them to bring runs back into view."
          : hasActiveStructuredFilters
            ? "Current filters are hiding every run. Clear them to bring runs back into view."
            : hasSearch
              ? "Current search is hiding every run. Clear it to bring runs back into view."
              : "Current filters are hiding every run. Clear them to bring runs back into view.";

    return (
      <section className="runs-list-region runs-list-region--state">
        <EmptyPanel
          action={
            runs.length > 0 ? (
              <button className="btn" onClick={onResetFilters} type="button">
                Reset filters
              </button>
            ) : undefined
          }
          body={emptyBody}
          title={emptyTitle}
        />
      </section>
    );
  }

  return (
    <section className="runs-list-region" aria-label="Runs list">
      <div aria-label="List status filters" className="status-filter-chips" role="toolbar">
        <button
          aria-label={`All statuses, ${visibleRuns.length} ${visibleRuns.length === 1 ? "run" : "runs"}`}
          aria-pressed={listStatusFilter === null}
          className="status-filter-chip"
          onClick={() => onListStatusFilterChange(null)}
          type="button"
        >
          All <span>{visibleRuns.length}</span>
        </button>
        {listStatusCounts.map((statusCount) => (
          <button
            aria-label={`${statusCount.label}, ${statusCount.count} ${statusCount.count === 1 ? "run" : "runs"}`}
            aria-pressed={listStatusFilter === statusCount.status}
            className="status-filter-chip"
            key={statusCount.status}
            onClick={() => onListStatusFilterChange(statusCount.status)}
            type="button"
          >
            {statusCount.label} <span>{statusCount.count}</span>
          </button>
        ))}
      </div>

      {listRows.length === 0 ? (
        <div className="runs-list-empty">
          <EmptyPanel
            action={
              listStatusFilter !== null ? (
                <button
                  className="btn"
                  onClick={() => onListStatusFilterChange(null)}
                  type="button"
                >
                  Show all statuses
                </button>
              ) : (
                <button className="btn" onClick={onResetFilters} type="button">
                  Reset filters
                </button>
              )
            }
            body="No runs match the active list status filter."
            title="No matching status"
          />
        </div>
      ) : (
        <div className="runs-list-rows">
          {listRows.map((run) =>
            mobileListCards ? (
              <RunCard
                actionPending={actionPending}
                key={run.runId}
                onRequestActionMenu={(point) => onRequestActionMenu(run.runId, point)}
                onSelect={() => onSelectRun(run.runId)}
                onSetNote={(note) => onSetNote(run.runId, note)}
                onSetPinned={(pinned) => onSetPinned(run.runId, pinned)}
                onStructuredFilterToggle={onStructuredFilterToggle}
                run={run}
                selected={selectedRunId === run.runId}
                structuredFilters={structuredFilters}
              />
            ) : (
              <RunRow
                actionPending={actionPending}
                key={run.runId}
                onOpenNote={() => onOpenNote(run.runId)}
                onRequestActionMenu={(point) => onRequestActionMenu(run.runId, point)}
                onSelect={() => onSelectRun(run.runId)}
                onSetPinned={(pinned) => onSetPinned(run.runId, pinned)}
                onStructuredFilterToggle={onStructuredFilterToggle}
                run={run}
                selected={selectedRunId === run.runId}
                sortField={sortField}
                structuredFilters={structuredFilters}
              />
            ),
          )}
        </div>
      )}
    </section>
  );
}
