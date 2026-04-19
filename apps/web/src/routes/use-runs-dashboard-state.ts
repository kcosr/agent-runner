import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  RunDetail,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunStatus,
  RunSummary,
} from "@task-runner/core/contracts/runs.js";
import { useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BoardColumn } from "../components/run-column.js";
import { createApiClient, isNotFoundError } from "../lib/api-client.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRunEvents } from "../lib/run-events.js";
import { compareRunsByStartedAtDesc, sortRunsWithPinnedFirst } from "../lib/run-order.js";
import { useRunTimelineState } from "../lib/run-timeline.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import {
  type AttachmentTab,
  DEFAULT_DRAWER_VIEW,
  type DashboardStructuredFilters,
  type DrawerDetailSection,
  EMPTY_DASHBOARD_STRUCTURED_FILTERS,
  type RunDrawerView,
  hasActiveDashboardStructuredFilters,
  toggleDashboardStructuredFilter,
  useDashboardPreferences,
  useDashboardViewState,
} from "../lib/settings.js";
import { subscribeToRunDetailEvents } from "../lib/sse.js";

export interface NoticeState {
  id: string;
  message: string;
  tone: "warning" | "error";
  autoDismissMs?: number;
}

export type RunActionPending =
  | "archive"
  | "unarchive"
  | "reset"
  | "delete"
  | "resume"
  | "abort"
  | "rename"
  | "note"
  | "pin"
  | "backend-session"
  | "upload-attachment"
  | "remove-attachment"
  | "download-attachment"
  | "add-dependency"
  | "remove-dependency"
  | "clear-dependencies";

const FAILURE_STATUSES: RunStatus[] = ["exhausted", "error"];
const DETAIL_LOAD_DELAY_MS = 120;

function useSettledDetailRunId(selectedRunId?: string) {
  const [detailRunId, setDetailRunId] = useState<string | undefined>(selectedRunId);

  useEffect(() => {
    if (detailRunId === selectedRunId) {
      return;
    }
    if (!selectedRunId) {
      setDetailRunId(undefined);
      return;
    }

    const timeoutId = window.setTimeout(() => {
      setDetailRunId(selectedRunId);
    }, DETAIL_LOAD_DELAY_MS);

    return () => {
      window.clearTimeout(timeoutId);
    };
  }, [detailRunId, selectedRunId]);

  return {
    detailRunId,
    detailSettling: detailRunId !== selectedRunId,
  };
}

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

function matchesStructuredFilters(
  run: RunSummary,
  structuredFilters: DashboardStructuredFilters,
): boolean {
  return (
    (structuredFilters.repo === null || run.repo === structuredFilters.repo) &&
    (structuredFilters.agent === null || run.agentName === structuredFilters.agent) &&
    (structuredFilters.backend === null || run.backend === structuredFilters.backend)
  );
}

function buildColumns(
  runs: RunSummary[],
  collapseFailureStates: boolean,
  compareRuns: (left: RunSummary, right: RunSummary) => number,
): BoardColumn[] {
  const base: BoardColumn[] = [
    { key: "pending", title: "Pending", statuses: ["initialized"], runs: [] },
    { key: "running", title: "Running", statuses: ["running"], runs: [] },
  ];

  if (collapseFailureStates) {
    base.push({ key: "blocked", title: "Blocked", statuses: ["blocked"], runs: [] });
    base.push({
      key: "failures",
      title: "Failed",
      statuses: FAILURE_STATUSES,
      runs: [],
    });
  } else {
    base.push(
      { key: "blocked", title: "Blocked", statuses: ["blocked"], runs: [] },
      { key: "error", title: "Error", statuses: ["error"], runs: [] },
      { key: "exhausted", title: "Exhausted", statuses: ["exhausted"], runs: [] },
    );
  }

  base.push({ key: "aborted", title: "Aborted", statuses: ["aborted"], runs: [] });
  base.push({ key: "completed", title: "Completed", statuses: ["success"], runs: [] });

  return base.map((column) => ({
    ...column,
    runs: sortRunsWithPinnedFirst(
      runs.filter((run) => column.statuses.includes(run.effectiveStatus)),
      compareRuns,
    ),
  }));
}

function compareRunsByRecentUpdate(
  left: RunSummary,
  right: RunSummary,
  recentUpdateSequenceByRunId: Record<string, number>,
): number {
  const leftSequence = recentUpdateSequenceByRunId[left.runId] ?? 0;
  const rightSequence = recentUpdateSequenceByRunId[right.runId] ?? 0;
  if (leftSequence !== rightSequence) {
    return rightSequence - leftSequence;
  }
  return compareRunsByStartedAtDesc(left, right);
}

function createRunComparator(
  sortByRecentUpdates: boolean,
  recentUpdateSequenceByRunId: Record<string, number>,
) {
  if (sortByRecentUpdates) {
    return (left: RunSummary, right: RunSummary) =>
      compareRunsByRecentUpdate(left, right, recentUpdateSequenceByRunId);
  }
  return compareRunsByStartedAtDesc;
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
    onSuccess?: (runId: string) => void;
  } = {},
) {
  return useMutation({
    mutationFn: action,
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (_result, runId) => {
      setActionError(undefined);
      await invalidateRunQueries(runId);
      options.onSuccess?.(runId);
    },
  });
}

function updateRunCaches(
  runId: string,
  update: {
    detail?: (run: RunDetail) => RunDetail;
    summary?: (run: RunSummary) => RunSummary;
  },
) {
  const updateDetail = update.detail;
  if (updateDetail) {
    queryClient.setQueryData<RunDetail | undefined>(runQueryKeys.detail(runId), (current) =>
      current ? updateDetail(current) : current,
    );
  }
  const updateSummary = update.summary;
  if (updateSummary) {
    queryClient.setQueryData<RunSummary[] | undefined>(runQueryKeys.list(), (current) =>
      current?.map((run) => (run.runId === runId ? updateSummary(run) : run)),
    );
  }
}

function updateRunNameCaches(result: RunNameResult) {
  updateRunCaches(result.runId, {
    detail: (run) => ({ ...run, name: result.name }),
    summary: (run) => ({ ...run, name: result.name }),
  });
}

function updateRunNoteCaches(result: RunNoteResult) {
  updateRunCaches(result.runId, {
    detail: (run) => ({ ...run, note: result.note }),
    summary: (run) => ({ ...run, notePresent: result.note !== null }),
  });
}

function updateRunPinnedCaches(result: RunPinnedResult) {
  updateRunCaches(result.runId, {
    detail: (run) => ({ ...run, pinned: result.pinned }),
    summary: (run) => ({ ...run, pinned: result.pinned }),
  });
}

function syncRunSummaryFromDetail(detail: RunDetail) {
  queryClient.setQueryData<RunSummary[] | undefined>(runQueryKeys.list(), (current) =>
    current?.map((run) =>
      run.runId === detail.runId
        ? {
            ...run,
            repo: detail.repo,
            status: detail.status,
            effectiveStatus: detail.effectiveStatus,
            archivedAt: detail.archivedAt,
            pinned: detail.pinned,
            notePresent: detail.note !== null,
            agentName: detail.agent.name,
            name: detail.name,
            assignmentName: detail.assignment?.name ?? null,
            backend: detail.backend,
            model: detail.model,
            cwd: detail.cwd,
            startedAt: detail.startedAt,
            endedAt: detail.endedAt,
            tasksCompleted: detail.tasksCompleted,
            tasksTotal: detail.tasksTotal,
            attachmentCount: detail.attachments.length,
            activeTask: detail.activeTask,
            execution: detail.execution,
            capabilities: detail.capabilities,
          }
        : run,
    ),
  );
}

async function invalidateRunQueries(runId: string) {
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: runQueryKeys.list() }),
    queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
  ]);
}

async function invalidateRunDetailQuery(runId: string) {
  await queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) });
}

export function useRunsDashboardState() {
  const config = useRuntimeConfig();
  const api = useMemo(() => createApiClient(config), [config]);
  const { preferences, updatePreferences } = useDashboardPreferences();
  const { viewState, updateViewState } = useDashboardViewState();
  const {
    markRunTouched,
    recentUpdateSequenceByRunId,
    streamStale: summaryStreamStale,
  } = useRunEvents();
  const deferredSearch = useDeferredValue(viewState.search);
  const navigate = useNavigate();
  const runRouteParams = useParams({ strict: false });
  const selectedRunId = "runId" in runRouteParams ? runRouteParams.runId : undefined;
  const [notices, setNotices] = useState<NoticeState[]>([]);
  const [actionError, setActionError] = useState<string>();
  const [detailStreamStale, setDetailStreamStale] = useState(false);
  const { detailRunId, detailSettling } = useSettledDetailRunId(selectedRunId);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumeMessageExpanded, setResumeMessageExpanded] = useState(false);
  const [resumeMessageDraft, setResumeMessageDraft] = useState("");
  const noticeTimersRef = useRef(new Map<string, number>());
  const detailStreamStaleRef = useRef(detailStreamStale);

  const runsQuery = useQuery({
    queryKey: runQueryKeys.list(),
    queryFn: () => api.listRuns(),
  });

  const selectedRunQuery = useQuery({
    queryKey: detailRunId ? runQueryKeys.detail(detailRunId) : runQueryKeys.detail("__none__"),
    queryFn: async ({ signal }) => {
      if (!detailRunId) {
        throw new Error("Selected run id is required");
      }
      return await api.getRun(detailRunId, { signal });
    },
    enabled: Boolean(detailRunId),
  });
  const timelineState = useRunTimelineState({
    config,
    runId: detailRunId,
    runIsLive: detailRunId === selectedRunId && selectedRunQuery.data?.isLive === true,
  });

  useEffect(() => {
    if (!selectedRunQuery.data) {
      return;
    }
    syncRunSummaryFromDetail(selectedRunQuery.data);
  }, [selectedRunQuery.data]);

  const runs = runsQuery.data ?? [];
  const filterOptions = useMemo(
    () => ({
      repo: Array.from(new Set(runs.map((run) => run.repo))).sort((left, right) =>
        left.localeCompare(right),
      ),
      agent: Array.from(new Set(runs.map((run) => run.agentName))).sort((left, right) =>
        left.localeCompare(right),
      ),
      backend: Array.from(new Set(runs.map((run) => run.backend))).sort((left, right) =>
        left.localeCompare(right),
      ),
    }),
    [runs],
  );
  const structuredVisibleRuns = useMemo(
    () =>
      runs.filter((run) => {
        if (!preferences.showArchived && run.archivedAt) {
          return false;
        }
        if (preferences.showPinnedOnly && !run.pinned) {
          return false;
        }
        return matchesStructuredFilters(run, preferences.structuredFilters);
      }),
    [preferences.showArchived, preferences.showPinnedOnly, preferences.structuredFilters, runs],
  );
  const visibleRuns = useMemo(
    () => structuredVisibleRuns.filter((run) => matchesSearch(run, deferredSearch)),
    [deferredSearch, structuredVisibleRuns],
  );
  const collapsedColumnKeySet = useMemo(
    () => new Set(viewState.collapsedColumnKeys),
    [viewState.collapsedColumnKeys],
  );
  const compareRuns = useMemo(
    () => createRunComparator(preferences.sortByRecentUpdates, recentUpdateSequenceByRunId),
    [preferences.sortByRecentUpdates, recentUpdateSequenceByRunId],
  );
  const columns = useMemo(
    () => buildColumns(visibleRuns, preferences.collapseFailureStates, compareRuns),
    [compareRuns, preferences.collapseFailureStates, visibleRuns],
  );
  const boardColumns = preferences.hideEmptyColumns
    ? columns.filter((column) => column.runs.length > 0)
    : columns;
  const selectedDrawerView =
    selectedRunId !== undefined
      ? (viewState.drawerViewsByRunId[selectedRunId] ?? DEFAULT_DRAWER_VIEW)
      : undefined;
  const selectedAttachmentTab =
    selectedDrawerView?.attachmentTab ?? DEFAULT_DRAWER_VIEW.attachmentTab;
  const selectedRunGroupAttachmentsQuery = useQuery({
    queryKey: ["attachment-list", detailRunId, "cwd-scope"],
    queryFn: async () => {
      if (!detailRunId) {
        throw new Error("Selected run id is required");
      }
      return await api.listAttachments(detailRunId, { cwdScope: true });
    },
    enabled:
      Boolean(detailRunId) &&
      selectedDrawerView?.detailSection === "attachments" &&
      selectedDrawerView.attachmentTab === "group",
    retry: false,
  });

  useEffect(() => {
    detailStreamStaleRef.current = detailStreamStale;
  }, [detailStreamStale]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: run on selection change to clear the prior run's pending resume-dialog state
  useEffect(() => {
    setResumeDialogOpen(false);
    setResumeMessageExpanded(false);
    setResumeMessageDraft("");
  }, [selectedRunId]);

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
    if (!detailRunId || detailRunId !== selectedRunId) {
      return;
    }

    if (selectedRunQuery.error && isNotFoundError(selectedRunQuery.error)) {
      setNotices((current) =>
        appendNotice(current, {
          id: `deleted-${detailRunId}`,
          message: `Run ${detailRunId} was deleted while selected.`,
          tone: "warning",
        }),
      );
      void navigate({ to: "/" });
    }
  }, [detailRunId, navigate, selectedRunId, selectedRunQuery.error]);

  useEffect(() => {
    if (!detailRunId) {
      detailStreamStaleRef.current = false;
      setDetailStreamStale(false);
      return;
    }
    const runId = detailRunId;

    let disposed = false;

    async function refreshActiveQueries() {
      await Promise.all([
        queryClient.refetchQueries(
          { queryKey: runQueryKeys.list(), type: "active" },
          { throwOnError: true },
        ),
        queryClient.refetchQueries(
          { queryKey: runQueryKeys.detail(runId), type: "active" },
          { throwOnError: true },
        ),
      ]);
    }

    const unsubscribe = subscribeToRunDetailEvents(config, runId, {
      onOpen: () => {
        if (!detailStreamStaleRef.current) {
          return;
        }
        void refreshActiveQueries()
          .then(() => {
            if (disposed) {
              return;
            }
            detailStreamStaleRef.current = false;
            setDetailStreamStale(false);
          })
          .catch(() => {
            // Keep the stale banner visible until a reconnect can revalidate successfully.
          });
      },
      onEvent: (payload) => {
        if (detailStreamStaleRef.current) {
          detailStreamStaleRef.current = false;
          setDetailStreamStale(false);
        }
        markRunTouched(payload.detail.runId);
        syncRunSummaryFromDetail(payload.detail);
        queryClient.setQueryData(runQueryKeys.detail(runId), payload.detail);
      },
      onStaleChange: (stale) => {
        if (!stale) {
          return;
        }
        detailStreamStaleRef.current = true;
        setDetailStreamStale(true);
      },
    });

    return () => {
      disposed = true;
      unsubscribe();
    };
  }, [config, detailRunId, markRunTouched]);

  const closeRun = () => {
    void navigate({ to: "/" });
  };

  const archiveMutation = useRunActionMutation(api.archiveRun, setActionError, {
    onSuccess: markRunTouched,
  });
  const unarchiveMutation = useRunActionMutation(api.unarchiveRun, setActionError, {
    onSuccess: markRunTouched,
  });
  const resetMutation = useRunActionMutation(api.resetRun, setActionError, {
    onSuccess: markRunTouched,
  });
  const deleteMutation = useMutation({
    mutationFn: (runId: string) => api.deleteRun(runId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      queryClient.removeQueries({ queryKey: runQueryKeys.detail(result.runId) });
      await invalidateRunQueries(result.runId);
      closeRun();
    },
  });
  const resumeMutation = useMutation({
    mutationFn: ({ message, runId }: { runId: string; message?: string }) =>
      api.resumeRun(runId, message),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (_result, { runId }) => {
      setActionError(undefined);
      markRunTouched(runId);
      await invalidateRunQueries(runId);
    },
  });
  const abortMutation = useRunActionMutation(api.abortRun, setActionError, {
    onSuccess: markRunTouched,
  });
  const renameMutation = useMutation({
    mutationFn: ({ name, runId }: { runId: string; name: string | null }) =>
      api.setRunName(runId, name),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result, { runId }) => {
      setActionError(undefined);
      updateRunNameCaches(result);
      markRunTouched(runId);
      await invalidateRunQueries(runId);
    },
  });
  const noteMutation = useMutation({
    mutationFn: ({ note, runId }: { runId: string; note: string | null }) =>
      api.setRunNote(runId, note),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      updateRunNoteCaches(result);
      markRunTouched(result.runId);
      await invalidateRunQueries(result.runId);
    },
  });
  const pinnedMutation = useMutation({
    mutationFn: ({ pinned, runId }: { runId: string; pinned: boolean }) =>
      api.setRunPinned(runId, pinned),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      updateRunPinnedCaches(result);
      markRunTouched(result.runId);
      await invalidateRunQueries(result.runId);
    },
  });
  const backendSessionMutation = useMutation({
    mutationFn: ({
      backendSessionId,
      clear,
      runId,
    }: {
      runId: string;
      backendSessionId?: string;
      clear?: boolean;
    }) =>
      clear ? api.clearBackendSession(runId) : api.setBackendSession(runId, backendSessionId ?? ""),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      await invalidateRunDetailQuery(result.runId);
    },
  });
  const addDependencyMutation = useMutation({
    mutationFn: ({ runId, dependencyRunId }: { runId: string; dependencyRunId: string }) =>
      api.addDependency(runId, dependencyRunId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      markRunTouched(result.runId);
      await invalidateRunQueries(result.runId);
    },
  });
  const removeDependencyMutation = useMutation({
    mutationFn: ({ runId, dependencyRunId }: { runId: string; dependencyRunId: string }) =>
      api.removeDependency(runId, dependencyRunId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      markRunTouched(result.runId);
      await invalidateRunQueries(result.runId);
    },
  });
  const clearDependenciesMutation = useMutation({
    mutationFn: (runId: string) => api.clearDependencies(runId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      markRunTouched(result.runId);
      await invalidateRunQueries(result.runId);
    },
  });
  const uploadAttachmentMutation = useMutation({
    mutationFn: ({ runId, file }: { runId: string; file: File }) =>
      api.uploadAttachment(runId, file),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (_result, { runId }) => {
      setActionError(undefined);
      markRunTouched(runId);
      await invalidateRunQueries(runId);
    },
  });
  const removeAttachmentMutation = useMutation({
    mutationFn: ({ runId, attachmentId }: { runId: string; attachmentId: string }) =>
      api.removeAttachment(runId, attachmentId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      markRunTouched(result.runId);
      await invalidateRunQueries(result.runId);
    },
  });
  const downloadAttachmentMutation = useMutation({
    mutationFn: async ({
      runId,
      attachmentId,
      name,
    }: { runId: string; attachmentId: string; name: string }) => {
      const blob = await api.downloadAttachment(runId, attachmentId);
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = name;
      document.body.append(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
    },
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: () => {
      setActionError(undefined);
    },
  });

  const actionPending: RunActionPending | undefined = archiveMutation.isPending
    ? "archive"
    : unarchiveMutation.isPending
      ? "unarchive"
      : resetMutation.isPending
        ? "reset"
        : deleteMutation.isPending
          ? "delete"
          : resumeMutation.isPending
            ? "resume"
            : abortMutation.isPending
              ? "abort"
              : renameMutation.isPending
                ? "rename"
                : noteMutation.isPending
                  ? "note"
                  : pinnedMutation.isPending
                    ? "pin"
                    : backendSessionMutation.isPending
                      ? "backend-session"
                      : uploadAttachmentMutation.isPending
                        ? "upload-attachment"
                        : removeAttachmentMutation.isPending
                          ? "remove-attachment"
                          : downloadAttachmentMutation.isPending
                            ? "download-attachment"
                            : addDependencyMutation.isPending
                              ? "add-dependency"
                              : removeDependencyMutation.isPending
                                ? "remove-dependency"
                                : clearDependenciesMutation.isPending
                                  ? "clear-dependencies"
                                  : undefined;
  const selectedRunDetailReady =
    detailRunId !== undefined &&
    detailRunId === selectedRunId &&
    selectedRunQuery.data?.runId === detailRunId;
  const selectedRunDetail = selectedRunDetailReady ? selectedRunQuery.data : undefined;
  const selectedRunCanResume = selectedRunDetail?.capabilities.canResume === true;
  const selectedRunPrimaryActionAvailable = selectedRunCanResume && actionPending === undefined;
  const selectedRunStartable = selectedRunCanResume && selectedRunDetail?.status === "initialized";
  const selectedRunHasIncompleteTasks =
    selectedRunDetail?.tasks.some((task) => task.status !== "completed") ?? true;
  const selectedRunResumeRequiresMessage = selectedRunCanResume && !selectedRunHasIncompleteTasks;
  const trimmedResumeMessage = resumeMessageDraft.trim();

  function resetResumeDialogState() {
    setResumeDialogOpen(false);
    setResumeMessageExpanded(false);
    setResumeMessageDraft("");
  }

  function setColumnCollapsed(columnKey: string, collapsed: boolean) {
    const isCollapsed = collapsedColumnKeySet.has(columnKey);
    if (collapsed === isCollapsed) {
      return;
    }

    updateViewState({
      collapsedColumnKeys: collapsed
        ? [...viewState.collapsedColumnKeys, columnKey]
        : viewState.collapsedColumnKeys.filter((key) => key !== columnKey),
    });
  }

  function setSelectedRunDrawerView(runId: string, drawerView: RunDrawerView) {
    updateViewState((current) => ({
      drawerViewsByRunId: {
        ...current.drawerViewsByRunId,
        [runId]: drawerView,
      },
    }));
  }

  function closeResumeDialog() {
    if (actionPending === "resume") {
      return;
    }
    resetResumeDialogState();
  }

  function openResumeDialog() {
    if (!selectedRunCanResume || actionPending !== undefined) {
      return;
    }
    setResumeMessageExpanded(selectedRunResumeRequiresMessage);
    setResumeDialogOpen(true);
  }

  async function submitSelectedRunResume() {
    if (
      !selectedRunId ||
      !selectedRunCanResume ||
      actionPending === "resume" ||
      (selectedRunResumeRequiresMessage && trimmedResumeMessage.length === 0)
    ) {
      return;
    }
    try {
      await resumeMutation.mutateAsync({
        runId: selectedRunId,
        message: trimmedResumeMessage.length > 0 ? trimmedResumeMessage : undefined,
      });
      setActionError(undefined);
      resetResumeDialogState();
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  async function triggerSelectedRunPrimaryAction() {
    if (!selectedRunId || !selectedRunCanResume || actionPending !== undefined) {
      return;
    }
    if (!selectedRunStartable) {
      openResumeDialog();
      return;
    }
    try {
      await resumeMutation.mutateAsync({ runId: selectedRunId });
      setActionError(undefined);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  return {
    actionError,
    activeBoardColumnKey: viewState.activeBoardColumnKey,
    actionPending,
    boardColumns,
    collapsedColumnKeys: viewState.collapsedColumnKeys,
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
    openRun: (runId: string, options?: { replace?: boolean }) => {
      setActionError(undefined);
      void navigate({ replace: options?.replace, to: `/runs/${runId}` });
    },
    openSelectedRunResumeDialog: openResumeDialog,
    openSelectedRunAttachmentPreview: (
      attachmentOwnerRunId: string,
      attachmentId: string,
      attachmentTab: AttachmentTab,
    ) => {
      if (!selectedRunId) {
        return;
      }
      setSelectedRunDrawerView(selectedRunId, {
        mode: "attachment",
        detailSection: "attachments",
        attachmentId,
        attachmentOwnerRunId,
        attachmentTab,
      });
    },
    preferences,
    filterOptions,
    hasActiveStructuredFilters: hasActiveDashboardStructuredFilters(preferences.structuredFilters),
    resumeDialogOpen,
    resumeMessageDraft,
    resumeMessageExpanded,
    runActions: {
      abort: (runId: string) => abortMutation.mutate(runId),
      addDependency: async (runId: string, dependencyRunId: string) => {
        await addDependencyMutation.mutateAsync({ runId, dependencyRunId });
      },
      archive: (runId: string) => archiveMutation.mutate(runId),
      clearDependencies: async (runId: string) => {
        await clearDependenciesMutation.mutateAsync(runId);
      },
      delete: (runId: string) => deleteMutation.mutate(runId),
      downloadAttachment: async (runId: string, attachmentId: string, name: string) => {
        await downloadAttachmentMutation.mutateAsync({ runId, attachmentId, name });
      },
      removeDependency: async (runId: string, dependencyRunId: string) => {
        await removeDependencyMutation.mutateAsync({ runId, dependencyRunId });
      },
      removeAttachment: async (runId: string, attachmentId: string) => {
        await removeAttachmentMutation.mutateAsync({ runId, attachmentId });
      },
      reset: (runId: string) => resetMutation.mutate(runId),
      rename: async (runId: string, name: string | null) => {
        await renameMutation.mutateAsync({ runId, name });
      },
      setNote: async (runId: string, note: string | null) => {
        await noteMutation.mutateAsync({ runId, note });
      },
      setPinned: async (runId: string, pinned: boolean) => {
        await pinnedMutation.mutateAsync({ runId, pinned });
      },
      clearBackendSession: async (runId: string) => {
        await backendSessionMutation.mutateAsync({ runId, clear: true });
      },
      resume: async (runId: string, message?: string) => {
        await resumeMutation.mutateAsync({ runId, message });
      },
      setBackendSession: async (runId: string, backendSessionId: string) => {
        await backendSessionMutation.mutateAsync({ runId, backendSessionId });
      },
      uploadAttachment: async (runId: string, file: File) => {
        await uploadAttachmentMutation.mutateAsync({ runId, file });
      },
      unarchive: (runId: string) => unarchiveMutation.mutate(runId),
    },
    runs,
    runsQuery,
    detailSettling,
    selectedRunId,
    selectedDrawerView,
    selectedRunGroupAttachmentsQuery,
    selectedRunCanResume,
    selectedRunPrimaryActionAvailable,
    selectedRunQuery,
    setResumeMessageDraft,
    setResumeMessageExpanded,
    streamStale: summaryStreamStale || detailStreamStale || timelineState.stale,
    submitSelectedRunResume,
    timelineState,
    triggerSelectedRunPrimaryAction,
    returnSelectedRunToAttachments: () => {
      if (!selectedRunId) {
        return;
      }
      setSelectedRunDrawerView(selectedRunId, {
        mode: "detail",
        detailSection: "attachments",
        attachmentId: null,
        attachmentOwnerRunId: null,
        attachmentTab: selectedAttachmentTab,
      });
    },
    resetBoardFilters: () => {
      updateViewState({ search: "" });
      updatePreferences({
        showArchived: false,
        showPinnedOnly: false,
        structuredFilters: EMPTY_DASHBOARD_STRUCTURED_FILTERS,
      });
    },
    setActiveBoardColumnKey: (columnKey: string | null) => {
      if (viewState.activeBoardColumnKey === columnKey) {
        return;
      }
      updateViewState({ activeBoardColumnKey: columnKey });
    },
    toggleDrawerFullscreen: () => {
      updateViewState({ drawerFullscreen: !viewState.drawerFullscreen });
    },
    updateSelectedRunDetailSection: (detailSection: DrawerDetailSection) => {
      if (!selectedRunId) {
        return;
      }
      setSelectedRunDrawerView(selectedRunId, {
        mode: "detail",
        detailSection,
        attachmentId: null,
        attachmentOwnerRunId: null,
        attachmentTab: selectedAttachmentTab,
      });
    },
    updateSelectedRunAttachmentTab: (attachmentTab: AttachmentTab) => {
      if (!selectedRunId) {
        return;
      }
      setSelectedRunDrawerView(selectedRunId, {
        mode: "detail",
        detailSection: "attachments",
        attachmentId: null,
        attachmentOwnerRunId: null,
        attachmentTab,
      });
    },
    toggleStructuredFilter: (key: keyof DashboardStructuredFilters, value: string) => {
      updatePreferences({
        structuredFilters: toggleDashboardStructuredFilter(
          preferences.structuredFilters,
          key,
          value,
        ),
      });
    },
    updatePreferences,
    updateViewState,
    visibleRuns,
    viewState,
    closeSelectedRunResumeDialog: closeResumeDialog,
  };
}
