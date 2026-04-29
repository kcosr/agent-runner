import { useMutation, useQuery } from "@tanstack/react-query";
import { useNavigate, useParams } from "@tanstack/react-router";
import type {
  RunArchiveResult,
  RunDependencyRef,
  RunDetail,
  RunGroupResult,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunStatus,
  RunSummary,
} from "@task-runner/core/contracts/runs.js";
import { deriveDependencyStateFromDetails } from "@task-runner/core/core/run/dependencies.js";
import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { BoardColumn } from "../components/run-column.js";
import { type ReconfigureRunPatch, createApiClient, isNotFoundError } from "../lib/api-client.js";
import { queryClient, runQueryKeys } from "../lib/query.js";
import { useRunAuditState } from "../lib/run-audit.js";
import { useRunEvents } from "../lib/run-events.js";
import { createRunComparator, sortRunsWithPinnedFirst } from "../lib/run-order.js";
import { getRunPrimaryAction } from "../lib/run-primary-action.js";
import { useRunTimelineState } from "../lib/run-timeline.js";
import { useRuntimeConfig } from "../lib/runtime-config.js";
import {
  DEFAULT_DRAWER_VIEW,
  type DashboardRightSurface,
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

interface NoticeState {
  id: string;
  message: string;
  tone: "warning" | "error";
  autoDismissMs?: number;
}

interface HistoryActivationState {
  audit: boolean;
  runId?: string;
  timeline: boolean;
}

export type RunActionPending =
  | "archive"
  | "unarchive"
  | "reset"
  | "delete"
  | "ready"
  | "resume"
  | "abort"
  | "rename"
  | "note"
  | "pin"
  | "backend-session"
  | "set-group"
  | "schedule"
  | "reconfigure"
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

function attachmentsDetailDrawerView(): RunDrawerView {
  return {
    mode: "detail",
    detailSection: "attachments",
    attachmentId: null,
    attachmentOwnerRunId: null,
  };
}

function attachmentPreviewDrawerView(
  attachmentOwnerRunId: string,
  attachmentId: string,
): RunDrawerView {
  return {
    mode: "attachment",
    detailSection: "attachments",
    attachmentId,
    attachmentOwnerRunId,
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

function updateRunListCaches(
  update: (runs: RunSummary[] | undefined) => RunSummary[] | undefined,
): void {
  queryClient.setQueriesData<RunSummary[] | undefined>({ queryKey: runQueryKeys.lists() }, update);
}

function buildColumns(
  runs: RunSummary[],
  collapseFailureStates: boolean,
  compareRuns: (left: RunSummary, right: RunSummary) => number,
): BoardColumn[] {
  const base: BoardColumn[] = [
    { key: "initialized", title: "Initialized", statuses: ["initialized"], runs: [] },
    { key: "ready", title: "Ready", statuses: ["ready"], runs: [] },
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
    updateRunListCaches((current) =>
      current?.map((run) => (run.runId === runId ? updateSummary(run) : run)),
    );
  }
}

function updateRunUpdatedAtCaches(runId: string, updatedAt: string) {
  updateRunCaches(runId, {
    detail: (run) => ({ ...run, updatedAt }),
    summary: (run) => ({ ...run, updatedAt }),
  });
}

function updateRunNameCaches(result: RunNameResult) {
  updateRunCaches(result.runId, {
    detail: (run) => ({ ...run, name: result.name, updatedAt: result.updatedAt }),
    summary: (run) => ({ ...run, name: result.name, updatedAt: result.updatedAt }),
  });
}

function updateRunNoteCaches(result: RunNoteResult) {
  updateRunCaches(result.runId, {
    detail: (run) => ({ ...run, note: result.note, updatedAt: result.updatedAt }),
    summary: (run) => ({
      ...run,
      notePresent: result.note !== null,
      updatedAt: result.updatedAt,
    }),
  });
}

function updateRunPinnedCaches(result: RunPinnedResult) {
  updateRunCaches(result.runId, {
    detail: (run) => ({ ...run, pinned: result.pinned, updatedAt: result.updatedAt }),
    summary: (run) => ({ ...run, pinned: result.pinned, updatedAt: result.updatedAt }),
  });
}

function updateRunArchivedCaches(result: RunArchiveResult) {
  updateRunCaches(result.runId, {
    detail: (run) => ({
      ...run,
      archivedAt: result.archivedAt,
      updatedAt: result.updatedAt,
      capabilities: {
        ...run.capabilities,
        canArchive: result.archivedAt === null && run.status !== "running",
        canUnarchive: result.archivedAt !== null && run.status !== "running",
      },
    }),
    summary: (run) => ({
      ...run,
      archivedAt: result.archivedAt,
      updatedAt: result.updatedAt,
      capabilities: {
        ...run.capabilities,
        canArchive: result.archivedAt === null && run.status !== "running",
        canUnarchive: result.archivedAt !== null && run.status !== "running",
      },
    }),
  });
}

function syncRunSummaryFromDetail(detail: RunDetail) {
  updateRunListCaches((current) =>
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
            updatedAt: detail.updatedAt,
            endedAt: detail.endedAt,
            tasksCompleted: detail.tasksCompleted,
            tasksTotal: detail.tasksTotal,
            dependencyState: deriveDependencyStateFromDetails(detail.dependencies),
            schedule: detail.schedule,
            scheduleState: detail.scheduleState,
            attachmentCount: detail.attachments.length,
            runGroupId: detail.runGroupId,
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
    queryClient.invalidateQueries({ queryKey: runQueryKeys.lists() }),
    queryClient.invalidateQueries({ queryKey: runQueryKeys.detail(runId) }),
  ]);
}

function shouldInvalidateSimpleRunMutation(
  runId: string,
  options: {
    detailRunId?: string;
    summaryStreamStale: boolean;
    detailStreamStale: boolean;
  },
): boolean {
  return options.summaryStreamStale || (options.detailRunId === runId && options.detailStreamStale);
}

async function invalidateIfChangedAndStale(
  result: { changed: boolean; runId: string },
  options: {
    detailRunId?: string;
    summaryStreamStale: boolean;
    detailStreamStale: boolean;
  },
) {
  if (result.changed && shouldInvalidateSimpleRunMutation(result.runId, options)) {
    await invalidateRunQueries(result.runId);
  }
}

export function useRunsDashboardState() {
  const config = useRuntimeConfig();
  const api = useMemo(() => createApiClient(config), [config]);
  const { preferences, updatePreferences } = useDashboardPreferences();
  const { viewState, updateViewState } = useDashboardViewState();
  const { streamStale: summaryStreamStale } = useRunEvents();
  const deferredSearch = useDeferredValue(viewState.search);
  const navigate = useNavigate();
  const runRouteParams = useParams({ strict: false });
  const selectedRunId = "runId" in runRouteParams ? runRouteParams.runId : undefined;
  const previewAttachmentOwnerRunId =
    "attachmentOwnerRunId" in runRouteParams ? runRouteParams.attachmentOwnerRunId : undefined;
  const previewAttachmentId =
    "attachmentId" in runRouteParams ? runRouteParams.attachmentId : undefined;
  const [notices, setNotices] = useState<NoticeState[]>([]);
  const [actionError, setActionError] = useState<string>();
  const [detailStreamStale, setDetailStreamStale] = useState(false);
  const { detailRunId, detailSettling } = useSettledDetailRunId(selectedRunId);
  const [resumeDialogOpen, setResumeDialogOpen] = useState(false);
  const [resumeMessageExpanded, setResumeMessageExpanded] = useState(false);
  const [resumeMessageDraft, setResumeMessageDraft] = useState("");
  const [historyActivation, setHistoryActivation] = useState<HistoryActivationState>({
    audit: false,
    timeline: false,
  });
  const noticeTimersRef = useRef(new Map<string, number>());
  const detailStreamStaleRef = useRef(detailStreamStale);
  const runGroupFilter = preferences.structuredFilters.runGroupId;

  const runsQuery = useQuery({
    queryKey: runQueryKeys.list(runGroupFilter),
    queryFn: ({ signal }) => api.listRuns({ runGroupId: runGroupFilter, signal }),
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
  const selectedRunIsLive = detailRunId === selectedRunId && selectedRunQuery.data?.isLive === true;
  const selectedStoredDrawerView =
    selectedRunId !== undefined
      ? (viewState.drawerViewsByRunId[selectedRunId] ?? DEFAULT_DRAWER_VIEW)
      : undefined;
  const routeAttachmentPreviewView =
    selectedRunId && previewAttachmentOwnerRunId && previewAttachmentId
      ? attachmentPreviewDrawerView(previewAttachmentOwnerRunId, previewAttachmentId)
      : undefined;
  const selectedDrawerView =
    routeAttachmentPreviewView ??
    (selectedStoredDrawerView?.mode === "attachment"
      ? attachmentsDetailDrawerView()
      : selectedStoredDrawerView);
  const selectedViewMatchesDetailRun = detailRunId !== undefined && detailRunId === selectedRunId;
  const timelineActive =
    selectedViewMatchesDetailRun &&
    selectedDrawerView?.mode === "detail" &&
    selectedDrawerView.detailSection === "events";
  const chatTimelineActive =
    selectedViewMatchesDetailRun && viewState.activeRightSurface === "chat";
  const auditActive =
    selectedViewMatchesDetailRun &&
    selectedDrawerView?.mode === "detail" &&
    selectedDrawerView.detailSection === "audit";
  const historyActivationMatchesDetailRun = historyActivation.runId === detailRunId;
  const timelineEnabled =
    chatTimelineActive ||
    timelineActive ||
    (selectedViewMatchesDetailRun &&
      historyActivationMatchesDetailRun &&
      historyActivation.timeline);
  const auditEnabled =
    auditActive ||
    (selectedViewMatchesDetailRun && historyActivationMatchesDetailRun && historyActivation.audit);

  useEffect(() => {
    setHistoryActivation((current) => {
      if (!selectedViewMatchesDetailRun) {
        return current.runId === undefined && !current.timeline && !current.audit
          ? current
          : { audit: false, timeline: false };
      }

      const base =
        current.runId === detailRunId
          ? current
          : { audit: false, runId: detailRunId, timeline: false };
      const next = {
        audit: base.audit || auditActive,
        runId: detailRunId,
        timeline: base.timeline || timelineActive || chatTimelineActive,
      };

      return next.audit === current.audit &&
        next.runId === current.runId &&
        next.timeline === current.timeline
        ? current
        : next;
    });
  }, [auditActive, chatTimelineActive, detailRunId, selectedViewMatchesDetailRun, timelineActive]);

  const timelineState = useRunTimelineState({
    config,
    enabled: timelineEnabled,
    runId: detailRunId,
    runIsLive: selectedRunIsLive,
  });
  const auditState = useRunAuditState({
    config,
    enabled: auditEnabled,
    runId: detailRunId,
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
        if (preferences.showNotesOnly && !run.notePresent) {
          return false;
        }
        if (preferences.showScheduledOnly && run.schedule === null) {
          return false;
        }
        if (preferences.showPinnedOnly && !run.pinned) {
          return false;
        }
        return matchesStructuredFilters(run, preferences.structuredFilters);
      }),
    [
      preferences.showArchived,
      preferences.showNotesOnly,
      preferences.showScheduledOnly,
      preferences.showPinnedOnly,
      preferences.structuredFilters,
      runs,
    ],
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
    () => createRunComparator(preferences.sortField, preferences.sortDirection),
    [preferences.sortDirection, preferences.sortField],
  );
  const columns = useMemo(
    () => buildColumns(visibleRuns, preferences.collapseFailureStates, compareRuns),
    [compareRuns, preferences.collapseFailureStates, visibleRuns],
  );
  const boardColumns = preferences.hideEmptyColumns
    ? columns.filter((column) => column.runs.length > 0)
    : columns;
  const selectedRunGroupAttachmentsQuery = useQuery({
    queryKey: ["attachment-list", detailRunId, "group"],
    queryFn: async () => {
      if (!detailRunId) {
        throw new Error("Selected run id is required");
      }
      return await api.listAttachments(detailRunId, { scope: "group" });
    },
    enabled: Boolean(detailRunId),
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
          { queryKey: runQueryKeys.lists(), type: "active" },
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
  }, [config, detailRunId]);

  const closeRun = () => {
    void navigate({ to: "/" });
  };

  function setActiveRightSurface(activeRightSurface: DashboardRightSurface) {
    if (viewState.activeRightSurface === activeRightSurface) {
      return;
    }
    updateViewState({ activeRightSurface });
  }

  const archiveMutation = useMutation({
    mutationFn: (runId: string) => api.archiveRun(runId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      if (result.changed) {
        updateRunArchivedCaches(result);
      }
      await invalidateIfChangedAndStale(result, {
        detailRunId,
        summaryStreamStale,
        detailStreamStale: detailStreamStaleRef.current,
      });
    },
  });
  const unarchiveMutation = useMutation({
    mutationFn: (runId: string) => api.unarchiveRun(runId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      if (result.changed) {
        updateRunArchivedCaches(result);
      }
      await invalidateIfChangedAndStale(result, {
        detailRunId,
        summaryStreamStale,
        detailStreamStale: detailStreamStaleRef.current,
      });
    },
  });
  const resetMutation = useRunActionMutation(api.resetRun, setActionError);
  const readyMutation = useRunActionMutation(api.readyRun, setActionError);
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
    onSuccess: (_result, { runId }) => {
      setActionError(undefined);
      void invalidateRunQueries(runId);
    },
  });
  const abortMutation = useRunActionMutation(api.abortRun, setActionError);
  const renameMutation = useMutation({
    mutationFn: ({ name, runId }: { runId: string; name: string | null }) =>
      api.setRunName(runId, name),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      if (result.changed) {
        updateRunNameCaches(result);
      }
      await invalidateIfChangedAndStale(result, {
        detailRunId,
        summaryStreamStale,
        detailStreamStale: detailStreamStaleRef.current,
      });
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
      if (result.changed) {
        updateRunNoteCaches(result);
      }
      await invalidateIfChangedAndStale(result, {
        detailRunId,
        summaryStreamStale,
        detailStreamStale: detailStreamStaleRef.current,
      });
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
      if (result.changed) {
        updateRunPinnedCaches(result);
      }
      await invalidateIfChangedAndStale(result, {
        detailRunId,
        summaryStreamStale,
        detailStreamStale: detailStreamStaleRef.current,
      });
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
      if (result.changed) {
        updateRunCaches(result.runId, {
          detail: (run) => ({
            ...run,
            backendSessionId: result.backendSessionId,
            updatedAt: result.updatedAt,
          }),
          summary: (run) => ({ ...run, updatedAt: result.updatedAt }),
        });
      }
      await invalidateIfChangedAndStale(result, {
        detailRunId,
        summaryStreamStale,
        detailStreamStale: detailStreamStaleRef.current,
      });
    },
  });
  const scheduleMutation = useMutation({
    mutationFn: ({ enabled, runId }: { runId: string; enabled?: boolean }) =>
      enabled === undefined
        ? api.clearRunSchedule(runId)
        : api.setRunScheduleEnabled(runId, enabled),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (detail) => {
      setActionError(undefined);
      queryClient.setQueryData(runQueryKeys.detail(detail.runId), detail);
      syncRunSummaryFromDetail(detail);
      if (
        shouldInvalidateSimpleRunMutation(detail.runId, {
          detailRunId,
          summaryStreamStale,
          detailStreamStale: detailStreamStaleRef.current,
        })
      ) {
        await invalidateRunQueries(detail.runId);
      }
    },
  });
  const reconfigureMutation = useMutation({
    mutationFn: ({ patch, runId }: { runId: string; patch: ReconfigureRunPatch }) =>
      api.reconfigureRun(runId, patch),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (detail) => {
      setActionError(undefined);
      queryClient.setQueryData(runQueryKeys.detail(detail.runId), detail);
      syncRunSummaryFromDetail(detail);
      if (
        shouldInvalidateSimpleRunMutation(detail.runId, {
          detailRunId,
          summaryStreamStale,
          detailStreamStale: detailStreamStaleRef.current,
        })
      ) {
        await invalidateRunQueries(detail.runId);
      }
    },
  });
  const setGroupMutation = useMutation({
    mutationFn: ({
      clear,
      runGroupId,
      runId,
    }: {
      runId: string;
      runGroupId?: string;
      clear?: boolean;
    }) => (clear ? api.clearRunGroup(runId) : api.setRunGroup(runId, runGroupId ?? "")),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result: RunGroupResult) => {
      setActionError(undefined);
      if (result.changed) {
        updateRunCaches(result.runId, {
          detail: (run) => ({
            ...run,
            runGroupId: result.runGroupId,
            updatedAt: result.updatedAt,
          }),
          summary: (run) => ({
            ...run,
            runGroupId: result.runGroupId,
            updatedAt: result.updatedAt,
          }),
        });
        await invalidateRunQueries(result.runId);
      }
    },
  });
  const addDependencyMutation = useMutation({
    mutationFn: ({ dependency, runId }: { runId: string; dependency: RunDependencyRef }) =>
      api.addDependency(runId, dependency),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      if (result.changed) {
        updateRunUpdatedAtCaches(result.runId, result.updatedAt);
        await invalidateRunQueries(result.runId);
      }
    },
  });
  const removeDependencyMutation = useMutation({
    mutationFn: ({ dependency, runId }: { runId: string; dependency: RunDependencyRef }) =>
      api.removeDependency(runId, dependency),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      if (result.changed) {
        updateRunUpdatedAtCaches(result.runId, result.updatedAt);
        await invalidateRunQueries(result.runId);
      }
    },
  });
  const clearDependenciesMutation = useMutation({
    mutationFn: (runId: string) => api.clearDependencies(runId),
    onError: (error: Error) => {
      setActionError(error.message);
    },
    onSuccess: async (result) => {
      setActionError(undefined);
      if (result.changed) {
        updateRunUpdatedAtCaches(result.runId, result.updatedAt);
        await invalidateRunQueries(result.runId);
      }
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
        : readyMutation.isPending
          ? "ready"
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
                        : setGroupMutation.isPending
                          ? "set-group"
                          : scheduleMutation.isPending
                            ? "schedule"
                            : reconfigureMutation.isPending
                              ? "reconfigure"
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
  const resumePendingRunId = resumeMutation.isPending ? resumeMutation.variables?.runId : undefined;
  const selectedRunDetailReady =
    detailRunId !== undefined &&
    detailRunId === selectedRunId &&
    selectedRunQuery.data?.runId === detailRunId;
  const selectedRunDetail = selectedRunDetailReady ? selectedRunQuery.data : undefined;
  const selectedRunPrimaryAction =
    selectedRunDetail === undefined ? null : getRunPrimaryAction(selectedRunDetail);
  const selectedRunPrimaryActionAvailable =
    selectedRunPrimaryAction !== null && actionPending === undefined;
  const selectedRunHasIncompleteTasks =
    selectedRunDetail?.tasks.some((task) => task.status !== "completed") ?? true;
  const selectedRunResumeRequiresMessage =
    selectedRunPrimaryAction === "resume" && !selectedRunHasIncompleteTasks;
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

  const setSelectedRunDrawerView = useCallback(
    (runId: string, drawerView: RunDrawerView) => {
      updateViewState((current) => ({
        drawerViewsByRunId: {
          ...current.drawerViewsByRunId,
          [runId]: drawerView,
        },
      }));
    },
    [updateViewState],
  );

  function closeResumeDialog() {
    if (actionPending === "resume") {
      return;
    }
    resetResumeDialogState();
  }

  function openResumeDialog() {
    if (selectedRunPrimaryAction !== "resume" || actionPending !== undefined) {
      return;
    }
    setResumeMessageExpanded(selectedRunResumeRequiresMessage);
    setResumeDialogOpen(true);
  }

  async function submitSelectedRunResume() {
    if (
      !selectedRunId ||
      selectedRunPrimaryAction !== "resume" ||
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
    if (!selectedRunId || selectedRunPrimaryAction === null || actionPending !== undefined) {
      return;
    }
    if (selectedRunPrimaryAction === "resume") {
      openResumeDialog();
      return;
    }
    try {
      if (selectedRunPrimaryAction === "ready") {
        await readyMutation.mutateAsync(selectedRunId);
      } else {
        await resumeMutation.mutateAsync({ runId: selectedRunId });
      }
      setActionError(undefined);
    } catch {
      // actionError is surfaced by the shared mutation handler.
    }
  }

  function navigateToRunDetail(runId: string, options?: { replace?: boolean }) {
    void navigate({ params: { runId }, replace: options?.replace, to: "/runs/$runId" });
  }

  function navigateToAttachmentPreview(
    runId: string,
    attachmentOwnerRunId: string,
    attachmentId: string,
    options?: { replace?: boolean },
  ) {
    void navigate({
      params: {
        attachmentId,
        attachmentOwnerRunId,
        runId,
      },
      replace: options?.replace,
      to: "/runs/$runId/attachments/$attachmentOwnerRunId/$attachmentId",
    });
  }

  useEffect(() => {
    if (!selectedRunId) {
      return;
    }

    if (previewAttachmentOwnerRunId && previewAttachmentId) {
      if (
        selectedStoredDrawerView?.mode === "attachment" &&
        selectedStoredDrawerView.attachmentId === previewAttachmentId &&
        selectedStoredDrawerView.attachmentOwnerRunId === previewAttachmentOwnerRunId
      ) {
        return;
      }
      setSelectedRunDrawerView(
        selectedRunId,
        attachmentPreviewDrawerView(previewAttachmentOwnerRunId, previewAttachmentId),
      );
      return;
    }

    if (selectedStoredDrawerView?.mode === "attachment") {
      setSelectedRunDrawerView(selectedRunId, attachmentsDetailDrawerView());
    }
  }, [
    previewAttachmentId,
    previewAttachmentOwnerRunId,
    selectedRunId,
    selectedStoredDrawerView,
    setSelectedRunDrawerView,
  ]);

  return {
    actionError,
    activeBoardColumnKey: viewState.activeBoardColumnKey,
    actionPending,
    activeRightSurface: viewState.activeRightSurface,
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
      const drawerView = viewState.drawerViewsByRunId[runId];
      if (drawerView?.mode === "attachment") {
        navigateToAttachmentPreview(
          runId,
          drawerView.attachmentOwnerRunId,
          drawerView.attachmentId,
          options,
        );
        return;
      }
      navigateToRunDetail(runId, options);
    },
    openSelectedRunAttachmentPreview: (attachmentOwnerRunId: string, attachmentId: string) => {
      if (!selectedRunId) {
        return;
      }
      const drawerView = attachmentPreviewDrawerView(attachmentOwnerRunId, attachmentId);
      setSelectedRunDrawerView(selectedRunId, drawerView);
      navigateToAttachmentPreview(selectedRunId, attachmentOwnerRunId, attachmentId);
    },
    replaceSelectedRunAttachmentPreview: (attachmentOwnerRunId: string, attachmentId: string) => {
      if (!selectedRunId) {
        return;
      }
      const drawerView = attachmentPreviewDrawerView(attachmentOwnerRunId, attachmentId);
      setSelectedRunDrawerView(selectedRunId, drawerView);
      navigateToAttachmentPreview(selectedRunId, attachmentOwnerRunId, attachmentId, {
        replace: true,
      });
    },
    preferences,
    filterOptions,
    hasActiveStructuredFilters: hasActiveDashboardStructuredFilters(preferences.structuredFilters),
    resumeDialogOpen,
    selectedRunResumeRequiresMessage,
    resumePendingRunId,
    resumeMessageDraft,
    resumeMessageExpanded,
    runActions: {
      abort: (runId: string) => abortMutation.mutate(runId),
      addDependency: async (runId: string, dependency: RunDependencyRef) => {
        await addDependencyMutation.mutateAsync({ runId, dependency });
      },
      archive: (runId: string) => archiveMutation.mutate(runId),
      clearDependencies: async (runId: string) => {
        await clearDependenciesMutation.mutateAsync(runId);
      },
      delete: (runId: string) => deleteMutation.mutate(runId),
      ready: async (runId: string) => {
        await readyMutation.mutateAsync(runId);
      },
      downloadAttachment: async (runId: string, attachmentId: string, name: string) => {
        await downloadAttachmentMutation.mutateAsync({ runId, attachmentId, name });
      },
      removeDependency: async (runId: string, dependency: RunDependencyRef) => {
        await removeDependencyMutation.mutateAsync({ runId, dependency });
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
      clearSchedule: async (runId: string) => {
        await scheduleMutation.mutateAsync({ runId });
      },
      resume: async (runId: string, message?: string) => {
        await resumeMutation.mutateAsync({ runId, message });
      },
      setBackendSession: async (runId: string, backendSessionId: string) => {
        await backendSessionMutation.mutateAsync({ runId, backendSessionId });
      },
      setGroup: async (runId: string, runGroupId: string) => {
        await setGroupMutation.mutateAsync({ runId, runGroupId });
      },
      clearGroup: async (runId: string) => {
        await setGroupMutation.mutateAsync({ runId, clear: true });
      },
      setScheduleEnabled: async (runId: string, enabled: boolean) => {
        await scheduleMutation.mutateAsync({ runId, enabled });
      },
      reconfigure: async (runId: string, patch: ReconfigureRunPatch) => {
        await reconfigureMutation.mutateAsync({ runId, patch });
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
    selectedRunPrimaryActionAvailable,
    selectedRunQuery,
    setResumeMessageDraft,
    setResumeMessageExpanded,
    streamStale: summaryStreamStale || detailStreamStale || auditState.stale,
    auditState,
    submitSelectedRunResume,
    timelineState,
    triggerSelectedRunPrimaryAction,
    returnSelectedRunToAttachments: () => {
      if (!selectedRunId) {
        return;
      }
      setSelectedRunDrawerView(selectedRunId, attachmentsDetailDrawerView());
      navigateToRunDetail(selectedRunId, { replace: true });
    },
    resetBoardFilters: () => {
      updateViewState({ search: "" });
      updatePreferences({
        showArchived: false,
        showNotesOnly: false,
        showPinnedOnly: false,
        structuredFilters: EMPTY_DASHBOARD_STRUCTURED_FILTERS,
      });
    },
    clearStructuredFilters: () => {
      updatePreferences({
        structuredFilters: EMPTY_DASHBOARD_STRUCTURED_FILTERS,
      });
    },
    setActiveBoardColumnKey: (columnKey: string | null) => {
      if (viewState.activeBoardColumnKey === columnKey) {
        return;
      }
      updateViewState({ activeBoardColumnKey: columnKey });
    },
    setActiveRightSurface,
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
      });
    },
    toggleStructuredFilter: (key: keyof DashboardStructuredFilters, value: string) => {
      updatePreferences((current) => ({
        structuredFilters: toggleDashboardStructuredFilter(current.structuredFilters, key, value),
      }));
    },
    updatePreferences,
    updateViewState,
    visibleRuns,
    viewState,
    closeSelectedRunResumeDialog: closeResumeDialog,
  };
}
