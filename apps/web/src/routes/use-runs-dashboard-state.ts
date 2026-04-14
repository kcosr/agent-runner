import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  RunDetail,
  RunNameResult,
  RunStatus,
  RunSummary,
} from "@task-runner/core/contracts/runs.js";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BoardColumn } from "../components/run-column.js";
import { createApiClient, isNotFoundError } from "../lib/api-client.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRunEvents } from "../lib/run-events.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import { useBoardSettings } from "../lib/settings.js";

export interface NoticeState {
  id: string;
  message: string;
  tone: "warning" | "error";
  autoDismissMs?: number;
}

export type RunActionPending = "archive" | "unarchive" | "resume" | "abort" | "rename";

const FAILURE_STATUSES: RunStatus[] = ["exhausted", "error"];

function matchesSearch(run: RunSummary, search: string): boolean {
  if (!search) {
    return true;
  }

  const haystack = [run.runId, run.name, run.assignmentName, run.agentName, run.repo, run.backend]
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
    base.push({ key: "blocked", title: "Blocked", statuses: ["blocked"], runs: [] });
    base.push({
      key: "failures",
      title: "Failures",
      statuses: FAILURE_STATUSES,
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
    runs: runs.filter((run) => column.statuses.includes(run.effectiveStatus)),
  }));
}

function selectedRunActiveTask(detail: RunDetail | undefined): string | undefined {
  if (!detail) {
    return undefined;
  }
  const inProgress = detail.tasks.filter((task) => task.status === "in_progress");
  return inProgress.length === 1 ? inProgress.at(0)?.id : undefined;
}

function appendNotice(current: NoticeState[], notice: NoticeState): NoticeState[] {
  if (current.some((entry) => entry.id === notice.id)) {
    return current;
  }
  return [...current, notice];
}

async function writeToClipboard(value: string): Promise<boolean> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Fall back to document-based copy for insecure origins and older browsers.
    }
  }

  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.top = "0";
  textarea.style.left = "-9999px";
  textarea.style.opacity = "0";
  document.body.append(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, value.length);

  try {
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    textarea.remove();
  }
}

function useRunActionMutation(
  action: (runId: string) => Promise<unknown>,
  setActionError: (message: string | undefined) => void,
  options: {
    onSuccess?: () => void;
  } = {},
) {
  return useMutation({
    mutationFn: action,
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (_result, runId) => {
      setActionError(undefined);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
      ]);
      options.onSuccess?.();
    },
  });
}

function updateRunNameCaches(result: RunNameResult) {
  queryClient.setQueryData<RunDetail | undefined>(runQueryKeys.detail(result.runId), (current) =>
    current ? { ...current, name: result.name } : current,
  );
  queryClient.setQueryData<RunSummary[] | undefined>(runQueryKeys.list(), (current) =>
    current?.map((run) => (run.runId === result.runId ? { ...run, name: result.name } : run)),
  );
}

export function useRunsDashboardState() {
  const config = useRuntimeConfig();
  const api = useMemo(() => createApiClient(config), [config]);
  const { settings, updateSettings } = useBoardSettings();
  const { streamStale } = useRunEvents();
  const deferredSearch = useDeferredValue(settings.search);
  const navigate = useNavigate();
  const runRouteParams = useParams({ strict: false });
  const selectedRunId = "runId" in runRouteParams ? runRouteParams.runId : undefined;
  const [notices, setNotices] = useState<NoticeState[]>([]);
  const [actionError, setActionError] = useState<string>();
  const noticeTimersRef = useRef(new Map<string, number>());

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
  const collapsedColumnKeySet = useMemo(
    () => new Set(settings.collapsedColumnKeys),
    [settings.collapsedColumnKeys],
  );
  const columns = useMemo(
    () => buildColumns(visibleRuns, settings.collapseFailureStates),
    [settings.collapseFailureStates, visibleRuns],
  );
  const boardColumns = settings.hideEmptyColumns
    ? columns.filter((column) => column.runs.length > 0)
    : columns;
  const activeTask = selectedRunActiveTask(selectedRunQuery.data);

  useEffect(() => {
    for (const notice of notices) {
      if (!notice.autoDismissMs || noticeTimersRef.current.has(notice.id)) {
        continue;
      }

      const timeoutId = window.setTimeout(() => {
        noticeTimersRef.current.delete(notice.id);
        setNotices((current) => current.filter((entry) => entry.id !== notice.id));
      }, notice.autoDismissMs);
      noticeTimersRef.current.set(notice.id, timeoutId);
    }

    for (const [id, timeoutId] of noticeTimersRef.current) {
      if (notices.some((notice) => notice.id === id)) {
        continue;
      }
      window.clearTimeout(timeoutId);
      noticeTimersRef.current.delete(id);
    }
  }, [notices]);

  useEffect(
    () => () => {
      for (const timeoutId of noticeTimersRef.current.values()) {
        window.clearTimeout(timeoutId);
      }
      noticeTimersRef.current.clear();
    },
    [],
  );

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    if (runsQuery.data && !runsQuery.data.some((run) => run.runId === selectedRunId)) {
      setNotices((current) =>
        appendNotice(current, {
          id: `missing-${selectedRunId}`,
          message: `Run ${selectedRunId} is no longer available. The detail view was closed.`,
          tone: "warning",
        }),
      );
      void navigate({ to: "/" });
      return;
    }

    if (selectedRunQuery.error && isNotFoundError(selectedRunQuery.error)) {
      setNotices((current) =>
        appendNotice(current, {
          id: `deleted-${selectedRunId}`,
          message: `Run ${selectedRunId} was deleted while selected.`,
          tone: "warning",
        }),
      );
      void navigate({ to: "/" });
    }
  }, [navigate, runsQuery.data, selectedRunId, selectedRunQuery.error]);

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") {
        return;
      }
      setActionError(undefined);
      void navigate({ to: "/" });
    }

    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [navigate, selectedRunId]);

  const closeRun = () => {
    void navigate({ to: "/" });
  };

  const archiveMutation = useRunActionMutation(api.archiveRun, setActionError, {
    onSuccess: closeRun,
  });
  const unarchiveMutation = useRunActionMutation(api.unarchiveRun, setActionError);
  const resumeMutation = useRunActionMutation(api.resumeRun, setActionError);
  const abortMutation = useRunActionMutation(api.abortRun, setActionError);
  const renameMutation = useMutation({
    mutationFn: ({ name, runId }: { runId: string; name: string | null }) =>
      api.setRunName(runId, name),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result, { runId }) => {
      setActionError(undefined);
      updateRunNameCaches(result);
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: runQueryKeys.list() }),
        queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
      ]);
    },
  });

  const actionPending: RunActionPending | undefined = archiveMutation.isPending
    ? "archive"
    : unarchiveMutation.isPending
      ? "unarchive"
      : resumeMutation.isPending
        ? "resume"
        : abortMutation.isPending
          ? "abort"
          : renameMutation.isPending
            ? "rename"
            : undefined;

  function setColumnCollapsed(columnKey: string, collapsed: boolean) {
    const isCollapsed = collapsedColumnKeySet.has(columnKey);
    if (collapsed === isCollapsed) {
      return;
    }

    updateSettings({
      collapsedColumnKeys: collapsed
        ? [...settings.collapsedColumnKeys, columnKey]
        : settings.collapsedColumnKeys.filter((key) => key !== columnKey),
    });
  }

  return {
    actionError,
    actionPending,
    boardColumns,
    collapsedColumnKeys: settings.collapsedColumnKeys,
    closeRun,
    columnActions: {
      expand: (columnKey: string) => {
        setColumnCollapsed(columnKey, false);
      },
      toggleCollapse: (columnKey: string) => {
        setColumnCollapsed(columnKey, !collapsedColumnKeySet.has(columnKey));
      },
    },
    copyText: async (value: string, label: string) => {
      if (await writeToClipboard(value)) {
        setNotices((current) =>
          appendNotice(current, {
            id: `copied-${label}-${Date.now()}`,
            message: `Copied ${label}.`,
            autoDismissMs: 4000,
            tone: "warning",
          }),
        );
      } else {
        setActionError(`Failed to copy ${label}.`);
      }
    },
    dismissNotice: (id: string) => {
      const timeoutId = noticeTimersRef.current.get(id);
      if (timeoutId !== undefined) {
        window.clearTimeout(timeoutId);
        noticeTimersRef.current.delete(id);
      }
      setNotices((current) => current.filter((notice) => notice.id !== id));
    },
    notices,
    openRun: (runId: string) => {
      setActionError(undefined);
      void navigate({ to: `/runs/${runId}` });
    },
    repoOptions,
    runActions: {
      abort: (runId: string) => abortMutation.mutate(runId),
      archive: (runId: string) => archiveMutation.mutate(runId),
      rename: async (runId: string, name: string | null) => {
        await renameMutation.mutateAsync({ runId, name });
      },
      resume: (runId: string) => resumeMutation.mutate(runId),
      unarchive: (runId: string) => unarchiveMutation.mutate(runId),
    },
    runs,
    runsQuery,
    selectedRunActiveTask: activeTask,
    selectedRunId,
    selectedRunQuery,
    settings,
    streamStale,
    updateSettings,
    visibleRuns,
  };
}
