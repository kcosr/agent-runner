import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { RunDetail, RunStatus, RunSummary } from "@task-runner/core/contracts/runs.js";
import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { AppShell } from "../components/app-shell.js";
import { EmptyPanel } from "../components/empty-states.js";
import { type BoardColumn, RunColumn } from "../components/run-column.js";
import { RunDetailDrawer } from "../components/run-detail-drawer.js";
import { RunFilters } from "../components/run-filters.js";
import { createApiClient, isNotFoundError } from "../lib/api-client.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRunEvents } from "../lib/run-events.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useBoardSettings } from "../lib/settings.js";

interface NoticeState {
  id: string;
  message: string;
  tone: "warning" | "error";
}

const FAILURE_STATUSES: RunStatus[] = ["blocked", "exhausted", "error"];

function matchesSearch(run: RunSummary, search: string): boolean {
  if (!search) {
    return true;
  }

  const haystack = [run.runId, run.assignmentName, run.agentName, run.repo, run.backend]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
  return haystack.includes(search.toLowerCase());
}

function buildColumns(runs: RunSummary[], collapseFailureStates: boolean): BoardColumn[] {
  const base: BoardColumn[] = [
    { key: "pending", title: "Pending", statuses: ["initialized"], runs: [] },
    { key: "running", title: "Running", statuses: ["running"], runs: [] },
    { key: "completed", title: "Completed", statuses: ["success"], runs: [] },
  ];

  if (collapseFailureStates) {
    base.push({
      key: "failures",
      title: "Failures",
      statuses: FAILURE_STATUSES,
      subLabel: "grouped: blocked · exhausted · error",
      runs: [],
    });
  } else {
    base.push(
      { key: "blocked", title: "Blocked", statuses: ["blocked"], runs: [] },
      { key: "exhausted", title: "Exhausted", statuses: ["exhausted"], runs: [] },
      { key: "error", title: "Error", statuses: ["error"], runs: [] },
    );
  }

  base.push({ key: "aborted", title: "Aborted", statuses: ["aborted"], runs: [] });

  return base.map((column) => ({
    ...column,
    runs: runs.filter((run) => column.statuses.includes(run.status)),
  }));
}

function selectedRunActiveTask(detail: RunDetail | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const inProgress = detail.tasks.filter((task) => task.status === "in_progress");
  return inProgress.length === 1 ? inProgress.at(0)?.id : undefined;
}

export function RunsDashboardRoute() {
  const config = useRuntimeConfig();
  const api = useMemo(() => createApiClient(config), [config]);
  const { settings, updateSettings } = useBoardSettings();
  const { streamStale } = useRunEvents();
  const deferredSearch = useDeferredValue(settings.search);
  const navigate = useNavigate();
  const runRouteParams = useParams({ strict: false });
  const selectedRunId = "runId" in runRouteParams ? runRouteParams.runId : undefined;
  const [showOptions, setShowOptions] = useState(false);
  const [notices, setNotices] = useState<NoticeState[]>([]);
  const [actionError, setActionError] = useState<string>();

  const runsQuery = useQuery({
    queryKey: runQueryKeys.list(),
    queryFn: () => api.listRuns(),
  });

  const selectedRunQuery = useQuery({
    queryKey: selectedRunId ? runQueryKeys.detail(selectedRunId) : runQueryKeys.detail("__none__"),
    queryFn: async () => {
      if (!selectedRunId) {
        throw new Error("Selected run id is required");
      }
      return await api.getRun(selectedRunId);
    },
    enabled: Boolean(selectedRunId),
  });

  const runs = runsQuery.data ?? [];
  const repoOptions = useMemo(
    () =>
      Array.from(new Set(runs.map((run) => run.repo))).sort((left, right) =>
        left.localeCompare(right),
      ),
    [runs],
  );
  const visibleRuns = useMemo(
    () =>
      runs.filter((run) => {
        if (!settings.showArchived && run.archivedAt) {
          return false;
        }
        if (settings.repo !== "all" && run.repo !== settings.repo) {
          return false;
        }
        return matchesSearch(run, deferredSearch);
      }),
    [deferredSearch, runs, settings.repo, settings.showArchived],
  );
  const columns = useMemo(
    () => buildColumns(visibleRuns, settings.collapseFailureStates),
    [settings.collapseFailureStates, visibleRuns],
  );
  const boardColumns = settings.hideEmptyColumns
    ? columns.filter((column) => column.runs.length > 0)
    : columns;

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    if (runsQuery.data && !runsQuery.data.some((run) => run.runId === selectedRunId)) {
      setNotices((current) => [
        ...current,
        {
          id: `missing-${selectedRunId}`,
          message: `Run ${selectedRunId} is no longer available. The detail view was closed.`,
          tone: "warning",
        },
      ]);
      void navigate({ to: "/" });
      return;
    }

    if (selectedRunQuery.error && isNotFoundError(selectedRunQuery.error)) {
      setNotices((current) => [
        ...current,
        {
          id: `deleted-${selectedRunId}`,
          message: `Run ${selectedRunId} was deleted while selected.`,
          tone: "warning",
        },
      ]);
      void navigate({ to: "/" });
    }
  }, [navigate, runsQuery.data, selectedRunId, selectedRunQuery.error]);

  function dismissNotice(id: string) {
    setNotices((current) => current.filter((notice) => notice.id !== id));
  }

  async function copyText(value: string, label: string) {
    try {
      await navigator.clipboard.writeText(value);
      setNotices((current) => [
        ...current,
        {
          id: `copied-${label}-${Date.now()}`,
          message: `Copied ${label}.`,
          tone: "warning",
        },
      ]);
    } catch {
      setActionError(`Failed to copy ${label}.`);
    }
  }

  const archiveMutation = useMutation({
    mutationFn: async (runId: string) => api.archiveRun(runId),
    onError: (error: Error) => setActionError(error.message),
    onSuccess: async (_, runId) => {
      setActionError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
      ]);
    },
  });

  const unarchiveMutation = useMutation({
    mutationFn: async (runId: string) => api.unarchiveRun(runId),
    onError: (error: Error) => setActionError(error.message),
    onSuccess: async (_, runId) => {
      setActionError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
      ]);
    },
  });

  const resumeMutation = useMutation({
    mutationFn: async (runId: string) => api.resumeRun(runId),
    onError: (error: Error) => setActionError(error.message),
    onSuccess: async (_, runId) => {
      setActionError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
      ]);
    },
  });

  const abortMutation = useMutation({
    mutationFn: async (runId: string) => api.abortRun(runId),
    onError: (error: Error) => setActionError(error.message),
    onSuccess: async (_, runId) => {
      setActionError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
      ]);
    },
  });

  const activeMutation = archiveMutation.isPending
    ? "archive"
    : unarchiveMutation.isPending
      ? "unarchive"
      : resumeMutation.isPending
        ? "resume"
        : abortMutation.isPending
          ? "abort"
          : undefined;

  const noticeNodes = [
    streamStale ? (
      <div className="notice" data-tone="warning" key="stream-stale">
        <span className="notice__message">
          Live updates are temporarily stale. The board stays usable and falls back to HTTP refetch.
        </span>
        <div className="notice__actions">
          <button className="btn" onClick={() => void runsQuery.refetch()} type="button">
            Refetch now
          </button>
        </div>
      </div>
    ) : null,
    ...notices.map((notice) => (
      <div className="notice" data-tone={notice.tone} key={notice.id}>
        <span className="notice__message">{notice.message}</span>
        <div className="notice__actions">
          <button
            aria-label="Dismiss notice"
            className="icon-btn icon-btn--small"
            onClick={() => dismissNotice(notice.id)}
            type="button"
          >
            ×
          </button>
        </div>
      </div>
    )),
  ].filter(Boolean);

  const board = runsQuery.isPending ? (
    <section aria-label="Run board" className="board">
      {["running", "completed", "failures"].map((key) => (
        <article className="column column-skeleton" data-status={key} key={key}>
          <header className="col-head">
            <div className="skeleton-line skeleton-line--short" />
          </header>
          <div className="col-body">
            {[0, 1, 2].map((index) => (
              <div className="card" key={index}>
                <div className="skeleton-line skeleton-line--short" />
                <div
                  className="skeleton-line skeleton-line--medium"
                  style={{ marginTop: "12px" }}
                />
                <div
                  className="skeleton-line skeleton-line--medium"
                  style={{ marginTop: "12px" }}
                />
              </div>
            ))}
          </div>
        </article>
      ))}
    </section>
  ) : runsQuery.isError ? (
    <section className="board board-error">
      <EmptyPanel
        action={
          <button className="btn" onClick={() => void runsQuery.refetch()} type="button">
            Retry board load
          </button>
        }
        body={(runsQuery.error as Error).message}
        title="Run board failed to load"
      />
    </section>
  ) : visibleRuns.length === 0 ? (
    <section className="board card-empty">
      <EmptyPanel
        action={
          runs.length > 0 ? (
            <button
              className="btn"
              onClick={() => updateSettings({ repo: "all", search: "", showArchived: false })}
              type="button"
            >
              Reset filters
            </button>
          ) : undefined
        }
        body={
          runs.length === 0
            ? "No runs are available yet. Start or initialize a run, then refresh this board."
            : "Current filters are hiding all runs. Reset them to bring runs back into view."
        }
        title={runs.length === 0 ? "No runs yet" : "Filters hide every run"}
      />
    </section>
  ) : (
    <section aria-label="Run board" className="board">
      {boardColumns.map((column) => (
        <RunColumn
          column={column}
          key={column.key}
          onSelectRun={(runId) => {
            setActionError(undefined);
            void navigate({ to: `/runs/${runId}` });
          }}
          selectedRunActiveTask={selectedRunActiveTask(selectedRunQuery.data)}
          selectedRunId={selectedRunId}
        />
      ))}
    </section>
  );

  let detail: React.ReactNode;
  if (!selectedRunId) {
    detail = undefined;
  } else if (selectedRunQuery.isPending) {
    detail = (
      <aside aria-label="Run detail" className="drawer drawer-skeleton">
        <div className="drawer-state">
          <div className="skeleton-line skeleton-line--short" />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
          <div className="skeleton-line skeleton-line--medium" style={{ marginTop: "12px" }} />
        </div>
      </aside>
    );
  } else if (selectedRunQuery.isError && !isNotFoundError(selectedRunQuery.error)) {
    detail = (
      <aside aria-label="Run detail" className="drawer">
        <div className="drawer-state">
          <h3>Run detail failed to load</h3>
          <p>{(selectedRunQuery.error as Error).message}</p>
          <button className="btn" onClick={() => void selectedRunQuery.refetch()} type="button">
            Retry detail load
          </button>
        </div>
      </aside>
    );
  } else if (selectedRunQuery.data) {
    const selectedRun = selectedRunQuery.data;
    detail = (
      <RunDetailDrawer
        actionError={actionError}
        actionPending={activeMutation}
        onAbort={() => abortMutation.mutate(selectedRun.runId)}
        onArchive={() => archiveMutation.mutate(selectedRun.runId)}
        onClose={() => void navigate({ to: "/" })}
        onCopy={(value, label) => void copyText(value, label)}
        onResume={() => resumeMutation.mutate(selectedRun.runId)}
        onUnarchive={() => unarchiveMutation.mutate(selectedRun.runId)}
        run={selectedRun}
      />
    );
  }

  return (
    <AppShell
      board={board}
      detail={detail}
      notices={noticeNodes.length > 0 ? noticeNodes : undefined}
      toolbar={
        <RunFilters
          repoOptions={repoOptions}
          settings={settings}
          showOptions={showOptions}
          toggleOptions={() => setShowOptions((current) => !current)}
          updateSettings={updateSettings}
        />
      }
    />
  );
}
