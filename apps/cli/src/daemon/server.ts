import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { type Socket, createServer as createNetServer } from "node:net";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import {
  type RunCommandOverrides,
  addDependency,
  addRunAttachmentFromStream,
  appendNotes,
  archive,
  clearBackendSession,
  clearDependencies,
  clearRunSchedule,
  createTask,
  deleteArchivedRun,
  getAttachment,
  getAttachmentList,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunAuditHistory,
  getRunBrief,
  getRunInputSurface,
  getRunList,
  getRunSummary,
  getRunTimelineHistory,
  getTask,
  getTaskList,
  initRun,
  readyRun,
  removeDependency,
  removeRunAttachment,
  renameRun,
  reset,
  resumeRun,
  setRunSchedule,
  setRunScheduleEnabled,
  startRun,
  unarchive,
  updateRunBackendSession,
  updateRunNote,
  updateRunPinned,
  updateTask,
} from "@task-runner/core/app/service.js";
import { VALID_STATUSES } from "@task-runner/core/assignment/model.js";
import { isPathArg } from "@task-runner/core/config/runtime-paths.js";
import type {
  RunAuditEnvelope,
  RunAuditHistory,
  RunDetailStreamEvent,
  RunSummaryStreamEvent,
  RunTimelineAttempt,
  RunTimelineEnvelope,
  RunTimelineEvent,
  RunTimelineHistory,
} from "@task-runner/core/contracts/events.js";
import type {
  RunAbortReason,
  RunCapabilities,
  RunDetail,
  RunStatus,
  RunSummary,
} from "@task-runner/core/contracts/runs.js";
import {
  deriveRunCapabilities,
  isDaemonAutoRunnableReadyRun,
  isTerminalStatus,
  toRunDetail,
} from "@task-runner/core/contracts/runs.js";
import {
  ConflictError,
  refreshRunSnapshotAfterTaskStateSettles,
} from "@task-runner/core/core/commands/service.js";
import {
  deriveDependencyState,
  resolveDependencies,
  resolveDependentsFromManifests,
} from "@task-runner/core/core/run/dependencies.js";
import {
  type ListedRunManifest,
  type RunManifest,
  RunNotFoundError,
  findRunManifestsById,
  listRunManifests,
  readManifest,
  resolveResumeTarget,
  writeManifest,
} from "@task-runner/core/core/run/manifest.js";
import { hasIncompleteTasks } from "@task-runner/core/core/run/resume-policy.js";
import {
  type ScheduleDecisionReason,
  appendRunScheduleAdvancedEvent,
  appendRunScheduleDisabledEvent,
  appendRunScheduleDueEvent,
  appendRunScheduleMissedEvent,
  appendRunScheduleSkippedEvent,
  systemRunEventContext,
} from "@task-runner/core/core/run/run-events.js";
import type { RunEvent } from "@task-runner/core/core/run/run-loop.js";
import {
  ScheduleValidationError,
  advanceRecurringSchedule,
  deriveScheduleState,
} from "@task-runner/core/core/run/schedule.js";
import { withTaskStateLock } from "@task-runner/core/core/run/workspace-state.js";
import {
  debugPerfEnabled,
  debugPerfLog,
  readDebugPerfIntervalMs,
  startDebugPerfTimer,
} from "@task-runner/core/util/debug-perf.js";
import { shortId } from "@task-runner/core/util/short-id.js";
import { WebSocket, WebSocketServer } from "ws";
import { deriveAppRuntimeConfig, deriveHttpBaseUrl, listenSocketConfig } from "./config.js";
import { serveFrontendRequest } from "./frontend.js";
import { isKnownControlPlaneError } from "./http-errors.js";
import { handleHttpRequest } from "./http-routes.js";
import { type DaemonHandlers, createDaemonOperations } from "./operations.js";
import {
  type JsonRpcRequest,
  type JsonRpcResponse,
  RPC_ERROR_COMMAND,
  RPC_ERROR_RUNTIME,
  type RunAuditNotificationParams,
  type RunDetailNotificationParams,
  type RunSummaryNotificationParams,
  type RunTimelineNotificationParams,
} from "./protocol.js";
import {
  RequestValidationError,
  asRecord,
  optionalEnum,
  optionalString,
  parseCliStartRunParams,
  parseResumeRunParams,
  parseRunReadyParams,
  parseRunScheduleParams,
  parseRunSetBackendSessionParams,
  parseRunSetNameParams,
  parseRunSetNoteParams,
  parseRunSetPinnedParams,
  parseRunsListParams,
  requiredRunIdString,
  requiredString,
} from "./request-parsing.js";

interface SummarySubscriptionRecord {
  id: string;
  owner: object;
  publish(summary: RunSummaryStreamEvent): boolean;
}

interface DetailSubscriptionRecord {
  id: string;
  owner: object;
  runId: string;
  publish(detail: RunDetailStreamEvent): boolean;
}

interface TimelineSubscriptionRecord {
  id: string;
  owner: object;
  runId: string;
  publish(event: RunTimelineEnvelope): boolean;
}

interface AuditSubscriptionRecord {
  id: string;
  owner: object;
  runId: string;
  publish(event: RunAuditEnvelope): boolean;
}

interface ActiveRunRecord {
  abortController: AbortController;
  done: Promise<void>;
  detail: RunDetail | null;
  auditBuffer: RunAuditEnvelope[];
  timelineBuffer: RunTimelineEnvelope[];
  nextCursor: number;
  currentAttempt: RunTimelineAttempt | null;
}

interface RecentTimelineRecord {
  events: RunTimelineEnvelope[];
  cleanupTimer: ReturnType<typeof setTimeout>;
}

interface RecentAuditRecord {
  events: RunAuditEnvelope[];
  cleanupTimer: ReturnType<typeof setTimeout>;
}

interface SubscriptionHandle {
  subscriptionId: string;
  unsubscribe(): void;
}

const MAX_TIMELINE_BUFFER_EVENTS = 1_000;
const COMPLETED_TIMELINE_BUFFER_TTL_MS = 5_000;
const MAX_SCHEDULE_TIMER_DELAY_MS = 2_147_483_647;
const SCHEDULED_RESUME_MESSAGE = "Resuming after scheduled delay.";

function roundMetric(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

function daemonExecution(daemonInstanceId: string) {
  return {
    hostMode: "daemon" as const,
    controller: {
      kind: "daemon" as const,
      daemonInstanceId,
    },
  };
}

function daemonMutationContext(daemonInstanceId: string) {
  return {
    hostMode: "daemon" as const,
    controllerInstanceId: daemonInstanceId,
  };
}

function deriveDaemonAbortCapability(
  runId: string,
  status: RunStatus,
  activeRuns: Map<string, ActiveRunRecord>,
): Pick<RunCapabilities, "canAbort" | "abortReason"> {
  if (activeRuns.has(runId)) {
    return { canAbort: true };
  }

  const abortReason: RunAbortReason = isTerminalStatus(status)
    ? "already_terminal"
    : "not_active_in_daemon";
  return {
    canAbort: false,
    abortReason,
  };
}

function withDaemonAbortCapability<T extends RunSummary | RunDetail>(
  run: T,
  activeRuns: Map<string, ActiveRunRecord>,
): T {
  const abortCapability = deriveDaemonAbortCapability(run.runId, run.status, activeRuns);
  const capabilities: RunCapabilities = {
    ...run.capabilities,
    ...abortCapability,
  };
  if (capabilities.canAbort) {
    capabilities.abortReason = undefined;
  }
  return {
    ...run,
    capabilities,
  };
}

function withDaemonDetailProjection(
  run: RunDetail,
  activeRuns: Map<string, ActiveRunRecord>,
): RunDetail {
  return {
    ...withDaemonAbortCapability(run, activeRuns),
    isLive: activeRuns.has(run.runId),
  };
}

function packageVersion(): string {
  const raw = readFileSync(new URL("../../package.json", import.meta.url), "utf8");
  const parsed = JSON.parse(raw) as { version?: string };
  return parsed.version ?? "0.0.0";
}

function errorResponse(id: string | number, err: unknown): JsonRpcResponse {
  const message = err instanceof Error ? err.message : String(err);
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code: isKnownControlPlaneError(err) ? RPC_ERROR_COMMAND : RPC_ERROR_RUNTIME,
      message,
    },
  };
}

function rpcErrorResponse(
  id: string | number | null,
  code: number,
  message: string,
): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    error: {
      code,
      message,
    },
  };
}

function resultResponse(id: string | number, result: unknown): JsonRpcResponse {
  return {
    jsonrpc: "2.0",
    id,
    result,
  };
}

function sendJson(ws: WebSocket, payload: JsonRpcResponse): void {
  if (ws.readyState !== WebSocket.OPEN) {
    return;
  }
  ws.send(JSON.stringify(payload));
}

function appendTimelineText(current: string, delta: string): string {
  return `${current}${delta}`;
}

function applyTimelineEnvelope(record: ActiveRunRecord, envelope: RunTimelineEnvelope): void {
  switch (envelope.event.type) {
    case "attempt_started":
      record.currentAttempt = {
        attemptNumber: envelope.event.attemptNumber,
        sessionIndex: envelope.event.sessionIndex,
        attemptIndexInSession: envelope.event.attemptIndexInSession,
        startedAt: envelope.event.startedAt,
        endedAt: null,
        prompt: envelope.event.prompt,
        transcript: "",
        notices: "",
        exitCode: null,
        timedOut: false,
        live: true,
      };
      return;
    case "agent_message_delta":
      if (record.currentAttempt) {
        record.currentAttempt.transcript = appendTimelineText(
          record.currentAttempt.transcript,
          envelope.event.text,
        );
      }
      return;
    case "backend_notice":
      if (record.currentAttempt) {
        record.currentAttempt.notices = appendTimelineText(
          record.currentAttempt.notices,
          envelope.event.text,
        );
      }
      return;
    case "retrying":
    case "run_aborted":
    case "resume_rejected":
    case "run_finished":
      record.currentAttempt = null;
      return;
    default:
      return;
  }
}

function bufferTimelineEvent(record: ActiveRunRecord, envelope: RunTimelineEnvelope): void {
  record.timelineBuffer.push(envelope);
  if (record.timelineBuffer.length > MAX_TIMELINE_BUFFER_EVENTS) {
    const overflow = record.timelineBuffer.length - MAX_TIMELINE_BUFFER_EVENTS;
    record.timelineBuffer.splice(0, overflow);
  }
  applyTimelineEnvelope(record, envelope);
}

function bufferAuditEvent(record: ActiveRunRecord, envelope: RunAuditEnvelope): void {
  record.auditBuffer.push(envelope);
  if (record.auditBuffer.length > MAX_TIMELINE_BUFFER_EVENTS) {
    const overflow = record.auditBuffer.length - MAX_TIMELINE_BUFFER_EVENTS;
    record.auditBuffer.splice(0, overflow);
  }
}

export interface DaemonServerHandle {
  listenUrl: string;
  httpBaseUrl: string;
  startedAt: string;
  close(): Promise<void>;
}

export async function serveDaemon(
  listenUrl: string,
  handlers: Partial<DaemonHandlers> = {},
): Promise<DaemonServerHandle> {
  const { host, port, path } = listenSocketConfig(listenUrl);
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const startedAt = new Date().toISOString();
  const daemonInstanceId = `daemon-${shortId()}`;
  const mutationAuditContext = daemonMutationContext(daemonInstanceId);
  const version = packageVersion();
  const summarySubscriptions = new Map<string, SummarySubscriptionRecord>();
  const detailSubscriptions = new Map<string, DetailSubscriptionRecord>();
  const timelineSubscriptions = new Map<string, TimelineSubscriptionRecord>();
  const auditSubscriptions = new Map<string, AuditSubscriptionRecord>();
  const activeRuns = new Map<string, ActiveRunRecord>();
  const manifestEntriesByRunId = new Map<string, ListedRunManifest>();
  const dependentRunIdsByRunId = new Map<string, Set<string>>();
  const pendingDependencyAutoStarts = new Set<string>();
  const pendingScheduleStarts = new Set<string>();
  const scheduleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingScheduleEvaluationTargets = new Set<string>();
  let manifestIndexInitialized = false;
  let fullScheduleEvaluationPending = false;
  let scheduleEvaluationQueued = false;
  const recentTimelineBuffers = new Map<string, RecentTimelineRecord>();
  const recentAuditBuffers = new Map<string, RecentAuditRecord>();
  const sockets = new Set<Socket>();
  const wsClients = new Set<WebSocket>();
  let queueReadyDependencyAutoStartSweep: (() => void) | null = null;
  let queueScheduleEvaluation: ((target?: string) => void) | null = null;
  let operations: ReturnType<typeof createDaemonOperations> | null = null;

  const app: DaemonHandlers = {
    getRun,
    getRunBrief,
    getRunList,
    getRunSummary,
    getRunAuditHistory,
    getRunTimelineHistory,
    getAttachment,
    getAttachmentList,
    getTask,
    getTaskList,
    getDefinition,
    getDefinitionList,
    getRunInputSurface,
    archive,
    unarchive,
    deleteArchivedRun,
    renameRun,
    updateRunNote,
    updateRunPinned,
    updateRunBackendSession,
    clearBackendSession,
    addDependency,
    removeDependency,
    clearDependencies,
    setRunSchedule,
    clearRunSchedule,
    setRunScheduleEnabled,
    addRunAttachmentFromStream,
    removeRunAttachment,
    reset,
    updateTask,
    appendNotes,
    createTask,
    initRun,
    readyRun,
    startRun,
    resumeRun,
    ...handlers,
  };

  const removeManifestIndexEntry = (runId: string): void => {
    const existing = manifestEntriesByRunId.get(runId);
    if (existing) {
      for (const dependencyRunId of existing.manifest.dependencyRunIds) {
        const dependents = dependentRunIdsByRunId.get(dependencyRunId);
        if (!dependents) {
          continue;
        }
        dependents.delete(runId);
        if (dependents.size === 0) {
          dependentRunIdsByRunId.delete(dependencyRunId);
        }
      }
    }
    manifestEntriesByRunId.delete(runId);
  };

  const rememberManifestIndexEntry = (entry: ListedRunManifest): void => {
    removeManifestIndexEntry(entry.manifest.runId);
    manifestEntriesByRunId.set(entry.manifest.runId, entry);
    for (const dependencyRunId of entry.manifest.dependencyRunIds) {
      const dependents = dependentRunIdsByRunId.get(dependencyRunId) ?? new Set<string>();
      dependents.add(entry.manifest.runId);
      dependentRunIdsByRunId.set(dependencyRunId, dependents);
    }
  };

  const rebuildManifestIndex = (): void => {
    const entries = listRunManifests();
    manifestEntriesByRunId.clear();
    dependentRunIdsByRunId.clear();
    for (const entry of entries) {
      rememberManifestIndexEntry(entry);
    }
    manifestIndexInitialized = true;
    queueReadyDependencyAutoStartSweep?.();
  };

  const ensureManifestIndex = (): void => {
    if (manifestIndexInitialized) {
      return;
    }
    rebuildManifestIndex();
  };

  const resolveManifestTarget = (target: string): ListedRunManifest => {
    try {
      const resolved = resolveResumeTarget(target);
      return {
        workspaceDir: resolved.workspaceDir,
        manifest: resolved.manifest,
      };
    } catch (error) {
      if (!(error instanceof RunNotFoundError) || isPathArg(target)) {
        throw error;
      }
      const matches = findRunManifestsById(target);
      if (matches.length === 0) {
        throw error;
      }
      if (matches.length > 1) {
        throw new ConflictError(
          `run id "${target}" is ambiguous across repo buckets; use a workspace path instead (${matches.map((entry) => entry.workspaceDir).join(", ")})`,
        );
      }
      const [match] = matches;
      if (!match) {
        throw error;
      }
      return match;
    }
  };

  const refreshManifestIndexEntry = (target: string): ListedRunManifest => {
    ensureManifestIndex();
    const entry = resolveManifestTarget(target);
    refreshRunSnapshotAfterTaskStateSettles(entry);
    rememberManifestIndexEntry(entry);
    return entry;
  };

  const refreshManifestByRunId = (runId: string): RunManifest | undefined => {
    try {
      return refreshManifestIndexEntry(runId).manifest;
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        return undefined;
      }
      throw error;
    }
  };

  const getDaemonRun = (target: string): RunDetail => {
    let run: RunDetail;
    if (app.getRun !== getRun) {
      run = app.getRun(target);
    } else {
      const entry = refreshManifestIndexEntry(target);
      const relatedManifests = new Map<string, RunManifest>([
        [entry.manifest.runId, entry.manifest],
      ]);
      for (const dependencyRunId of entry.manifest.dependencyRunIds) {
        const dependencyManifest = refreshManifestByRunId(dependencyRunId);
        if (dependencyManifest) {
          relatedManifests.set(dependencyRunId, dependencyManifest);
        }
      }
      const dependentRunIds = [
        ...(dependentRunIdsByRunId.get(entry.manifest.runId) ?? new Set<string>()),
      ];
      const dependentManifests: RunManifest[] = [];
      for (const dependentRunId of dependentRunIds) {
        const dependentManifest = refreshManifestByRunId(dependentRunId);
        if (dependentManifest) {
          dependentManifests.push(dependentManifest);
          relatedManifests.set(dependentRunId, dependentManifest);
        }
      }
      run = toRunDetail({
        manifest: entry.manifest,
        isLive: false,
        dependencies: resolveDependencies(entry.manifest, relatedManifests),
        dependents: resolveDependentsFromManifests(entry.manifest.runId, dependentManifests),
        relatedManifests,
      });
    }
    return withDaemonDetailProjection(run, activeRuns);
  };
  const getDaemonRunList = (opts?: Parameters<typeof app.getRunList>[0]): RunSummary[] =>
    app.getRunList(opts).map((run: RunSummary) => withDaemonAbortCapability(run, activeRuns));

  const getDaemonRunSummary = (target: string): RunSummary => {
    if (app.getRunSummary !== getRunSummary) {
      return withDaemonAbortCapability(app.getRunSummary(target), activeRuns);
    }
    try {
      return withDaemonAbortCapability(app.getRunSummary(target), activeRuns);
    } catch (error) {
      if (!(error instanceof RunNotFoundError) || app.getRunList === getRunList) {
        throw error;
      }
      const summary = app.getRunList({ includeArchived: true }).find((run) => run.runId === target);
      if (!summary) {
        throw error;
      }
      return withDaemonAbortCapability(summary, activeRuns);
    }
  };

  const getProjectedSummary = (runId: string): RunSummary | null => {
    const finish = startDebugPerfTimer("daemon.project.summary", { runId });
    try {
      const summary = getDaemonRunSummary(runId);
      finish({
        found: true,
        status: summary.status,
        dependencyTotal: summary.dependencyState?.total ?? null,
        tasksTotal: summary.tasksTotal ?? null,
      });
      return summary;
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        finish({ found: false });
        return null;
      }
      finish({
        found: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const getProjectedDetail = (runId: string): RunDetail | null => {
    const finish = startDebugPerfTimer("daemon.project.detail", { runId });
    try {
      const detail = getDaemonRun(runId);
      finish({
        found: true,
        taskCount: Array.isArray(detail.tasks) ? detail.tasks.length : null,
        dependencyCount: Array.isArray(detail.dependencies) ? detail.dependencies.length : null,
        attemptCount: detail.totalAttemptCount,
      });
      return detail;
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        finish({ found: false });
        return null;
      }
      finish({
        found: false,
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  };

  const lastTimelineCursorByRun = new Map<string, number>();

  const clearRecentTimelineBuffer = (runId: string): void => {
    const existing = recentTimelineBuffers.get(runId);
    if (!existing) {
      return;
    }
    clearTimeout(existing.cleanupTimer);
    recentTimelineBuffers.delete(runId);
  };

  const rememberRecentTimelineBuffer = (runId: string, events: RunTimelineEnvelope[]): void => {
    clearRecentTimelineBuffer(runId);
    const cleanupTimer = setTimeout(() => {
      recentTimelineBuffers.delete(runId);
    }, COMPLETED_TIMELINE_BUFFER_TTL_MS);
    cleanupTimer.unref?.();
    recentTimelineBuffers.set(runId, {
      events: [...events],
      cleanupTimer,
    });
  };

  const clearRecentAuditBuffer = (runId: string): void => {
    const existing = recentAuditBuffers.get(runId);
    if (!existing) {
      return;
    }
    clearTimeout(existing.cleanupTimer);
    recentAuditBuffers.delete(runId);
  };

  const rememberRecentAuditBuffer = (runId: string, events: RunAuditEnvelope[]): void => {
    clearRecentAuditBuffer(runId);
    const cleanupTimer = setTimeout(() => {
      recentAuditBuffers.delete(runId);
    }, COMPLETED_TIMELINE_BUFFER_TTL_MS);
    cleanupTimer.unref?.();
    recentAuditBuffers.set(runId, {
      events: [...events],
      cleanupTimer,
    });
  };

  const rememberRecentAuditEvent = (runId: string, envelope: RunAuditEnvelope): void => {
    const nextEvents = [...(recentAuditBuffers.get(runId)?.events ?? []), envelope];
    if (nextEvents.length > MAX_TIMELINE_BUFFER_EVENTS) {
      const overflow = nextEvents.length - MAX_TIMELINE_BUFFER_EVENTS;
      nextEvents.splice(0, overflow);
    }
    rememberRecentAuditBuffer(runId, nextEvents);
  };

  const getReplayableTimeline = (runId: string): RunTimelineEnvelope[] => {
    const active = activeRuns.get(runId);
    if (active) {
      return active.timelineBuffer;
    }
    return recentTimelineBuffers.get(runId)?.events ?? [];
  };

  const getReplayableAudit = (runId: string): RunAuditEnvelope[] => {
    const active = activeRuns.get(runId);
    if (active) {
      return active.auditBuffer;
    }
    return recentAuditBuffers.get(runId)?.events ?? [];
  };

  const getProjectedTimelineHistory = (runId: string): RunTimelineHistory => {
    const finish = startDebugPerfTimer("daemon.project.timeline_history", { runId });
    const history = app.getRunTimelineHistory(runId);
    const active = activeRuns.get(runId);
    const projected = !active
      ? history
      : {
          runId,
          attempts: active.currentAttempt
            ? [...history.attempts, { ...active.currentAttempt }]
            : history.attempts,
          lastCursor: active.nextCursor,
        };
    finish({
      active: Boolean(active),
      attemptCount: projected.attempts.length,
      lastCursor: projected.lastCursor,
    });
    return projected;
  };

  const getProjectedAuditHistory = (
    runId: string,
    options?: {
      limit?: number;
    },
  ): RunAuditHistory => {
    const finish = startDebugPerfTimer("daemon.project.audit_history", {
      runId,
      limit: options?.limit ?? null,
    });
    const history = app.getRunAuditHistory(runId, options);
    finish({
      eventCount: history.events.length,
      lastCursor: history.lastCursor,
    });
    return history;
  };

  const createActiveRunRecord = (
    abortController: AbortController,
    done: Promise<void>,
    runId: string,
  ): ActiveRunRecord => {
    const seededAuditBuffer = recentAuditBuffers.get(runId)?.events ?? [];
    clearRecentTimelineBuffer(runId);
    clearRecentAuditBuffer(runId);
    return {
      abortController,
      done,
      detail: getProjectedDetail(runId),
      auditBuffer: [...seededAuditBuffer],
      timelineBuffer: [],
      nextCursor: lastTimelineCursorByRun.get(runId) ?? 0,
      currentAttempt: null,
    };
  };

  const parseRunEventChannel = (
    value: unknown,
  ): "run_summary" | "run_detail" | "run_timeline" | "run_audit" => {
    const channel = requiredString(value, "channel");
    switch (channel) {
      case "run_summary":
      case "run_detail":
      case "run_timeline":
      case "run_audit":
        return channel;
      default:
        throw new RequestValidationError(
          'channel must be one of "run_summary", "run_detail", "run_timeline", or "run_audit"',
        );
    }
  };

  const dependentRunIds = (runId: string): string[] => [
    ...(dependentRunIdsByRunId.get(runId) ?? new Set<string>()),
  ];

  const shouldPublishDependentSummaries = (
    previous: RunDetail | null,
    current: RunDetail | null,
  ): boolean =>
    previous !== null &&
    current !== null &&
    (previous.status !== current.status || previous.effectiveStatus !== current.effectiveStatus);

  const shouldPublishDependentDetails = (
    previous: RunDetail | null,
    current: RunDetail | null,
  ): boolean =>
    previous !== null &&
    current !== null &&
    (shouldPublishDependentSummaries(previous, current) ||
      previous.archivedAt !== current.archivedAt ||
      previous.name !== current.name);

  const shouldAutoStartReadyDependencyRun = (
    manifest: ListedRunManifest,
    detail: RunDetail | null,
    active: Map<string, ActiveRunRecord>,
    pendingAutoStart: ReadonlySet<string>,
  ): boolean =>
    detail !== null &&
    manifest.manifest.dependencyRunIds.length > 0 &&
    isDaemonAutoRunnableReadyRun({
      manifest: manifest.manifest,
      dependencyState: {
        unsatisfied: detail.dependencies.filter((dependency) => !dependency.satisfied).length,
      },
      activeInDaemon:
        active.has(manifest.manifest.runId) ||
        pendingAutoStart.has(manifest.manifest.runId) ||
        pendingScheduleStarts.has(manifest.manifest.runId),
    });

  const shouldAutoStartReadyDependencySummary = (
    summary: RunSummary | null,
    active: Map<string, ActiveRunRecord>,
    pendingAutoStart: ReadonlySet<string>,
  ): boolean =>
    summary !== null &&
    summary.dependencyState.total > 0 &&
    isDaemonAutoRunnableReadyRun({
      manifest: {
        status: summary.status,
        schedule: summary.schedule,
        archivedAt: summary.archivedAt,
        backend: summary.backend,
      },
      dependencyState: summary.dependencyState,
      activeInDaemon:
        active.has(summary.runId) ||
        pendingAutoStart.has(summary.runId) ||
        pendingScheduleStarts.has(summary.runId),
    });

  const formatAutoStartError = (error: unknown): string =>
    error instanceof Error ? (error.stack ?? error.message) : String(error);

  const publishAutoStartRecovery = (runId: string, error: unknown): void => {
    console.error(
      `task-runner daemon: dependency auto-start failed for run ${runId}: ${formatAutoStartError(error)}`,
    );
    try {
      publishMutationResult(runId, {
        summary: getProjectedSummary(runId),
        detail: getProjectedDetail(runId),
      });
    } catch (publishError) {
      console.error(
        `task-runner daemon: failed to publish dependency auto-start recovery for run ${runId}: ${formatAutoStartError(publishError)}`,
      );
    }
  };

  const tryAutoStartDependencyRun = async (
    runId: string,
    provided?: {
      manifest?: ListedRunManifest;
      detail?: RunDetail | null;
      summary?: RunSummary | null;
    },
  ): Promise<boolean> => {
    if (
      provided?.summary !== undefined &&
      !shouldAutoStartReadyDependencySummary(
        provided.summary,
        activeRuns,
        pendingDependencyAutoStarts,
      )
    ) {
      return false;
    }
    const entry =
      provided?.manifest ??
      manifestEntriesByRunId.get(runId) ??
      (() => {
        try {
          return refreshManifestIndexEntry(runId);
        } catch (error) {
          if (error instanceof RunNotFoundError) {
            return null;
          }
          throw error;
        }
      })();
    if (!entry) {
      return false;
    }
    const detail = provided?.detail ?? getProjectedDetail(runId);
    if (
      operations === null ||
      !shouldAutoStartReadyDependencyRun(entry, detail, activeRuns, pendingDependencyAutoStarts)
    ) {
      return false;
    }

    pendingDependencyAutoStarts.add(runId);
    try {
      await operations.resumeRun({
        target: runId,
        overrides: {},
      });
      return true;
    } finally {
      pendingDependencyAutoStarts.delete(runId);
    }
  };

  const queueAutoStartDependencyRun = (
    runId: string,
    provided?: {
      manifest?: ListedRunManifest;
      detail?: RunDetail | null;
      summary?: RunSummary | null;
    },
  ): void => {
    void tryAutoStartDependencyRun(runId, provided).catch((error) => {
      publishAutoStartRecovery(runId, error);
    });
  };

  const clearScheduleTimer = (runId: string): void => {
    const timer = scheduleTimers.get(runId);
    if (!timer) {
      return;
    }
    clearTimeout(timer);
    scheduleTimers.delete(runId);
  };

  const armScheduleTimer = (runId: string, runAt: string, now: Date): void => {
    clearScheduleTimer(runId);
    const delayMs = Math.max(0, new Date(runAt).getTime() - now.getTime());
    const timer = setTimeout(
      () => queueScheduleEvaluation?.(runId),
      Math.min(delayMs, MAX_SCHEDULE_TIMER_DELAY_MS),
    );
    timer.unref?.();
    scheduleTimers.set(runId, timer);
  };

  const scheduleAuditContext = () => systemRunEventContext(mutationAuditContext);

  const publishScheduleRecovery = (runId: string, error: unknown): void => {
    console.error(
      `task-runner daemon: schedule evaluation failed for run ${runId}: ${formatAutoStartError(error)}`,
    );
    try {
      publishMutationResult(runId, {
        summary: getProjectedSummary(runId),
        detail: getProjectedDetail(runId),
      });
    } catch (publishError) {
      console.error(
        `task-runner daemon: failed to publish schedule recovery for run ${runId}: ${formatAutoStartError(publishError)}`,
      );
    }
  };

  const dependencyStateForScheduledRun = (manifest: RunManifest) =>
    deriveDependencyState(
      manifest,
      new Map(
        Array.from(manifestEntriesByRunId.values(), (entry) => [
          entry.manifest.runId,
          entry.manifest,
        ]),
      ),
    );

  const scheduledRunActiveInDaemon = (runId: string): boolean =>
    activeRuns.has(runId) ||
    pendingScheduleStarts.has(runId) ||
    pendingDependencyAutoStarts.has(runId);

  const scheduleSkipReason = (
    entry: ListedRunManifest,
    dependencyState: ReturnType<typeof dependencyStateForScheduledRun>,
  ): ScheduleDecisionReason | null => {
    if (entry.manifest.archivedAt !== null) {
      return "archived";
    }
    if (entry.manifest.status !== "ready" || entry.manifest.backend === "passive") {
      return "not_ready";
    }
    if (dependencyState.unsatisfied > 0) {
      return "dependencies_unmet";
    }
    return null;
  };

  const scheduledResumeOverrides = (manifest: RunManifest) =>
    hasIncompleteTasks(manifest.finalTasks) ? {} : { message: SCHEDULED_RESUME_MESSAGE };

  const mutateDueOneTimeSchedule = (
    entry: ListedRunManifest,
    reason: ScheduleDecisionReason,
    now: Date,
  ): boolean => {
    let changed = false;
    withTaskStateLock(entry.workspaceDir, () => {
      const latest = readManifest(entry.workspaceDir);
      if (
        latest.schedule === null ||
        latest.schedule.recurrence !== null ||
        deriveScheduleState(latest.schedule, now) !== "due"
      ) {
        rememberManifestIndexEntry({ ...entry, manifest: latest });
        return;
      }
      const missedSchedule = latest.schedule;
      latest.schedule = null;
      writeManifest(entry.workspaceDir, latest);
      rememberManifestIndexEntry({ ...entry, manifest: latest });
      publishAudit(
        appendRunScheduleMissedEvent({
          manifest: latest,
          context: scheduleAuditContext(),
          schedule: missedSchedule,
          reason,
        }),
      );
      changed = true;
    });
    return changed;
  };

  const mutateDueRecurringSchedule = (
    entry: ListedRunManifest,
    reason: ScheduleDecisionReason,
    now: Date,
  ): boolean => {
    let changed = false;
    withTaskStateLock(entry.workspaceDir, () => {
      const latest = readManifest(entry.workspaceDir);
      if (
        latest.schedule === null ||
        latest.schedule.recurrence === null ||
        deriveScheduleState(latest.schedule, now) !== "due"
      ) {
        rememberManifestIndexEntry({ ...entry, manifest: latest });
        return;
      }
      const previousSchedule = latest.schedule;
      let advanced: ReturnType<typeof advanceRecurringSchedule>;
      try {
        advanced = advanceRecurringSchedule(previousSchedule, now);
      } catch (error) {
        if (!(error instanceof ScheduleValidationError)) {
          throw error;
        }
        advanced = {
          schedule: {
            ...previousSchedule,
            enabled: false,
          },
          disabledReason: "minimum_interval_violation",
        };
      }
      latest.schedule = advanced.schedule;
      writeManifest(entry.workspaceDir, latest);
      rememberManifestIndexEntry({ ...entry, manifest: latest });
      publishAudit(
        appendRunScheduleSkippedEvent({
          manifest: latest,
          context: scheduleAuditContext(),
          schedule: previousSchedule,
          reason,
        }),
      );
      if (advanced.disabledReason) {
        publishAudit(
          appendRunScheduleDisabledEvent({
            manifest: latest,
            context: scheduleAuditContext(),
            schedule: latest.schedule,
            reason: advanced.disabledReason,
          }),
        );
      } else {
        publishAudit(
          appendRunScheduleAdvancedEvent({
            manifest: latest,
            context: scheduleAuditContext(),
            previousSchedule,
            schedule: latest.schedule,
            reason,
          }),
        );
      }
      changed = true;
    });
    return changed;
  };

  const skipDueSchedule = (
    entry: ListedRunManifest,
    reason: ScheduleDecisionReason,
    now: Date,
  ): void => {
    const schedule = entry.manifest.schedule;
    if (schedule === null) {
      return;
    }
    const changed =
      schedule.recurrence === null
        ? mutateDueOneTimeSchedule(entry, reason, now)
        : mutateDueRecurringSchedule(entry, reason, now);
    if (!changed) {
      return;
    }
    publishMutationResult(entry.manifest.runId, {
      summary: getProjectedSummary(entry.manifest.runId),
      detail: getProjectedDetail(entry.manifest.runId),
    });
    queueScheduleEvaluation?.(entry.manifest.runId);
  };

  const startDueScheduledRun = async (
    entry: ListedRunManifest,
    overrides: RunCommandOverrides = {},
  ): Promise<void> => {
    if (operations === null || pendingScheduleStarts.has(entry.manifest.runId)) {
      return;
    }
    const schedule = entry.manifest.schedule;
    if (schedule === null) {
      return;
    }
    pendingScheduleStarts.add(entry.manifest.runId);
    try {
      publishAudit(
        appendRunScheduleDueEvent({
          manifest: entry.manifest,
          context: scheduleAuditContext(),
          schedule,
        }),
      );
      publishMutationResult(entry.manifest.runId, {
        summary: getProjectedSummary(entry.manifest.runId),
        detail: getProjectedDetail(entry.manifest.runId),
      });
      await operations.resumeRun({
        target: entry.manifest.runId,
        overrides,
      });
    } finally {
      pendingScheduleStarts.delete(entry.manifest.runId);
      queueScheduleEvaluation?.(entry.manifest.runId);
    }
  };

  const evaluateScheduledRun = async (runId: string, options: { startup: boolean }) => {
    let entry: ListedRunManifest;
    try {
      entry = refreshManifestIndexEntry(runId);
    } catch (error) {
      if (error instanceof RunNotFoundError) {
        clearScheduleTimer(runId);
        return;
      }
      throw error;
    }

    const schedule = entry.manifest.schedule;
    if (schedule === null || !schedule.enabled) {
      clearScheduleTimer(runId);
      return;
    }
    const now = new Date();
    const scheduleState = deriveScheduleState(schedule, now);
    if (scheduleState === "future") {
      armScheduleTimer(runId, schedule.runAt, now);
      return;
    }
    if (scheduleState !== "due") {
      clearScheduleTimer(runId);
      return;
    }

    clearScheduleTimer(runId);
    if (options.startup) {
      skipDueSchedule(entry, "overdue_on_startup", now);
      return;
    }

    if (scheduledRunActiveInDaemon(entry.manifest.runId)) {
      return;
    }

    const dependencyState = dependencyStateForScheduledRun(entry.manifest);
    const capabilities = deriveRunCapabilities(entry.manifest, dependencyState);
    if (
      schedule.recurrence === null &&
      entry.manifest.status !== "ready" &&
      capabilities.canResume
    ) {
      await startDueScheduledRun(entry, scheduledResumeOverrides(entry.manifest));
      return;
    }

    const reason = scheduleSkipReason(entry, dependencyState);
    if (reason !== null) {
      skipDueSchedule(entry, reason, now);
      return;
    }
    if (
      !isDaemonAutoRunnableReadyRun({
        manifest: entry.manifest,
        dependencyState,
        activeInDaemon: false,
        now,
      })
    ) {
      skipDueSchedule(entry, "not_ready", now);
      return;
    }

    await startDueScheduledRun(
      entry,
      schedule.recurrence?.mode === "reuse" && entry.manifest.sessions.length > 0
        ? scheduledResumeOverrides(entry.manifest)
        : {},
    );
  };

  const evaluateSchedules = async (targets: string[] | null, options: { startup: boolean }) => {
    const runIds =
      targets ??
      Array.from(manifestEntriesByRunId.values(), (entry) => entry.manifest.runId).sort((a, b) =>
        a.localeCompare(b),
      );
    for (const runId of runIds) {
      try {
        await evaluateScheduledRun(runId, options);
      } catch (error) {
        publishScheduleRecovery(runId, error);
      }
    }
  };

  queueScheduleEvaluation = (target?: string): void => {
    if (target === undefined) {
      fullScheduleEvaluationPending = true;
      pendingScheduleEvaluationTargets.clear();
    } else if (!fullScheduleEvaluationPending) {
      pendingScheduleEvaluationTargets.add(target);
    }
    if (scheduleEvaluationQueued) {
      return;
    }
    scheduleEvaluationQueued = true;
    const timer = setTimeout(() => {
      scheduleEvaluationQueued = false;
      const targets = fullScheduleEvaluationPending ? null : [...pendingScheduleEvaluationTargets];
      fullScheduleEvaluationPending = false;
      pendingScheduleEvaluationTargets.clear();
      void evaluateSchedules(targets, { startup: false });
    }, 0);
    timer.unref?.();
  };

  const publishSummary = (summary: RunSummary): void => {
    const finish = startDebugPerfTimer("daemon.publish.summary", {
      runId: summary.runId,
      subscriberCount: summarySubscriptions.size,
    });
    const payload: RunSummaryStreamEvent = {
      type: "summary_upsert",
      summary,
    };
    let published = 0;
    for (const [id, subscription] of summarySubscriptions) {
      const keep = subscription.publish(payload);
      published++;
      if (!keep) {
        summarySubscriptions.delete(id);
      }
    }
    finish({ published });
  };

  const publishSummaryRemoval = (runId: string): void => {
    const payload: RunSummaryStreamEvent = {
      type: "summary_removed",
      runId,
    };
    for (const [id, subscription] of summarySubscriptions) {
      const keep = subscription.publish(payload);
      if (!keep) {
        summarySubscriptions.delete(id);
      }
    }
  };

  const publishDetail = (detail: RunDetail): void => {
    const finish = startDebugPerfTimer("daemon.publish.detail", {
      runId: detail.runId,
      subscriberCount: detailSubscriptions.size,
    });
    const payload: RunDetailStreamEvent = {
      type: "detail_updated",
      detail,
    };
    let published = 0;
    for (const [id, subscription] of detailSubscriptions) {
      if (subscription.runId !== detail.runId) {
        continue;
      }
      const keep = subscription.publish(payload);
      published++;
      if (!keep) {
        detailSubscriptions.delete(id);
      }
    }
    finish({ published });
  };

  const publishAudit = (envelope: RunAuditEnvelope): void => {
    const finish = startDebugPerfTimer("daemon.publish.audit", {
      runId: envelope.runId,
      cursor: envelope.cursor,
      subscriberCount: auditSubscriptions.size,
    });
    const active = activeRuns.get(envelope.runId);
    if (active) {
      bufferAuditEvent(active, envelope);
    } else {
      rememberRecentAuditEvent(envelope.runId, envelope);
    }
    let published = 0;
    for (const [id, subscription] of auditSubscriptions) {
      if (subscription.runId !== envelope.runId) {
        continue;
      }
      const keep = subscription.publish(envelope);
      published++;
      if (!keep) {
        auditSubscriptions.delete(id);
      }
    }
    finish({ published, active: Boolean(active) });
  };

  const publishTimeline = (runId: string, event: RunTimelineEvent): void => {
    const finish = startDebugPerfTimer("daemon.publish.timeline", {
      runId,
      eventType: event.type,
      subscriberCount: timelineSubscriptions.size,
    });
    const active = activeRuns.get(runId);
    if (!active) {
      finish({ active: false, published: 0 });
      return;
    }
    const cursor = active.nextCursor + 1;
    active.nextCursor = cursor;
    lastTimelineCursorByRun.set(runId, cursor);
    const envelope: RunTimelineEnvelope = { runId, cursor, event };
    bufferTimelineEvent(active, envelope);
    let published = 0;
    for (const [id, subscription] of timelineSubscriptions) {
      if (subscription.runId !== runId) {
        continue;
      }
      const keep = subscription.publish(envelope);
      published++;
      if (!keep) {
        timelineSubscriptions.delete(id);
      }
    }
    finish({
      active: true,
      cursor,
      published,
    });
  };

  const publishRunProjections = (
    runId: string,
    options: {
      summary?: RunSummary | null;
      detail?: RunDetail | null;
      publishDependentSummaries?: boolean;
      publishDependentDetails?: boolean;
    } = {},
  ): void => {
    const finish = startDebugPerfTimer("daemon.publish.projections", {
      runId,
      publishDependentSummaries: options.publishDependentSummaries ?? false,
      publishDependentDetails: options.publishDependentDetails ?? false,
    });
    const summary = options.summary === undefined ? getProjectedSummary(runId) : options.summary;
    if (summary) {
      publishSummary(summary);
    }

    const detail = options.detail === undefined ? getProjectedDetail(runId) : options.detail;
    if (detail) {
      publishDetail(detail);
      const active = activeRuns.get(runId);
      if (active) {
        active.detail = detail;
      }
    }

    if (!options.publishDependentSummaries && !options.publishDependentDetails) {
      return;
    }

    const dependents = dependentRunIds(runId);

    for (const dependentRunId of dependents) {
      let dependentSummary: RunSummary | null | undefined;
      let dependentDetail: RunDetail | null | undefined;
      if (options.publishDependentSummaries) {
        dependentSummary = getProjectedSummary(dependentRunId);
        if (dependentSummary) {
          publishSummary(dependentSummary);
        }
      }
      if (options.publishDependentDetails) {
        dependentDetail = getProjectedDetail(dependentRunId);
        if (dependentDetail) {
          publishDetail(dependentDetail);
        }
      }
      queueAutoStartDependencyRun(dependentRunId, {
        summary: dependentSummary,
        detail: dependentDetail,
      });
      queueScheduleEvaluation?.(dependentRunId);
    }
    finish({
      summaryPublished: summary !== null,
      detailPublished: detail !== null,
      dependentCount: dependents.length,
    });
  };

  const publishMutationResult = (
    runId: string,
    options: {
      summary?: RunSummary | null;
      detail?: RunDetail | null;
      publishDependentSummaries?: boolean;
      publishDependentDetails?: boolean;
    } = {},
  ): void => {
    publishRunProjections(runId, {
      summary: options.summary,
      detail: options.detail,
      publishDependentSummaries: options.publishDependentSummaries ?? false,
      publishDependentDetails: options.publishDependentDetails ?? false,
    });
  };

  const publishRunDeletion = (runId: string): void => {
    const dependents = dependentRunIds(runId);
    clearScheduleTimer(runId);
    removeManifestIndexEntry(runId);
    dependentRunIdsByRunId.delete(runId);
    publishSummaryRemoval(runId);
    for (const dependentRunId of dependents) {
      const dependentSummary = getProjectedSummary(dependentRunId);
      if (dependentSummary) {
        publishSummary(dependentSummary);
      }
      const dependentDetail = getProjectedDetail(dependentRunId);
      if (dependentDetail) {
        publishDetail(dependentDetail);
      }
    }
  };

  const applyPublishedMutation = <T>(
    runId: string,
    mutate: () => T,
    options: {
      inferDependentFanout?: boolean;
    } = {},
  ): {
    result: T;
    summary: RunSummary | null;
    detail: RunDetail | null;
  } => {
    const previous = options.inferDependentFanout ? getProjectedDetail(runId) : null;
    const result = mutate();
    const detail = getProjectedDetail(runId);
    const summary = getProjectedSummary(runId);
    publishMutationResult(runId, {
      summary,
      detail,
      publishDependentSummaries: shouldPublishDependentSummaries(previous, detail),
      publishDependentDetails: shouldPublishDependentDetails(previous, detail),
    });
    queueScheduleEvaluation?.(runId);
    return {
      result,
      summary,
      detail,
    };
  };

  const withPublishedMutation = <T>(
    runId: string,
    mutate: () => T,
    options: {
      inferDependentFanout?: boolean;
    } = {},
  ): T => {
    return applyPublishedMutation(runId, mutate, options).result;
  };

  const withPublishedMutationAsync = async <T>(
    runId: string,
    mutate: () => Promise<T>,
    options: {
      inferDependentFanout?: boolean;
    } = {},
  ): Promise<T> => {
    const previous = options.inferDependentFanout ? getProjectedDetail(runId) : null;
    const result = await mutate();
    const current = getProjectedDetail(runId);
    const summary = getProjectedSummary(runId);
    publishMutationResult(runId, {
      summary,
      detail: current,
      publishDependentSummaries: shouldPublishDependentSummaries(previous, current),
      publishDependentDetails: shouldPublishDependentDetails(previous, current),
    });
    queueScheduleEvaluation?.(runId);
    return result;
  };

  const withPublishedDetailMutation = <T>(runId: string, mutate: () => T): T => {
    const result = mutate();
    const detail = getProjectedDetail(runId);
    if (!detail) {
      return result;
    }
    publishDetail(detail);
    const active = activeRuns.get(runId);
    if (active) {
      active.detail = detail;
    }
    queueScheduleEvaluation?.(runId);
    return result;
  };

  await new Promise<void>((resolve, reject) => {
    const probe = createNetServer();
    const onListening = () => {
      cleanup();
      probe.close((err) => {
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    };
    const onError = (error: Error) => {
      cleanup();
      probe.close(() => {
        reject(error);
      });
    };
    const cleanup = () => {
      probe.off("listening", onListening);
      probe.off("error", onError);
    };
    probe.once("listening", onListening);
    probe.once("error", onError);
    probe.listen(port, host);
  });

  const createSubscription = <TRecord extends { id: string }>(
    store: Map<string, TRecord>,
    buildRecord: (subscriptionId: string) => TRecord,
    subscriptionId = `sub-${shortId()}`,
  ): SubscriptionHandle => {
    store.set(subscriptionId, buildRecord(subscriptionId));
    return {
      subscriptionId,
      unsubscribe: () => {
        store.delete(subscriptionId);
      },
    };
  };

  const subscribeRunSummaries = (
    owner: object,
    publish: (summary: RunSummaryStreamEvent) => boolean,
    subscriptionId = `sub-${shortId()}`,
  ): SubscriptionHandle =>
    createSubscription(
      summarySubscriptions,
      (id) => ({
        id,
        owner,
        publish,
      }),
      subscriptionId,
    );

  const subscribeRunDetail = (
    owner: object,
    runId: string,
    publish: (detail: RunDetailStreamEvent) => boolean,
    subscriptionId = `sub-${shortId()}`,
  ): SubscriptionHandle =>
    createSubscription(
      detailSubscriptions,
      (id) => ({
        id,
        owner,
        runId,
        publish,
      }),
      subscriptionId,
    );

  const subscribeRunTimeline = (
    owner: object,
    runId: string,
    publish: (event: RunTimelineEnvelope) => boolean,
    subscriptionId = `sub-${shortId()}`,
  ): SubscriptionHandle =>
    createSubscription(
      timelineSubscriptions,
      (id) => ({
        id,
        owner,
        runId,
        publish,
      }),
      subscriptionId,
    );

  const subscribeRunAudit = (
    owner: object,
    runId: string,
    publish: (event: RunAuditEnvelope) => boolean,
    subscriptionId = `sub-${shortId()}`,
  ): SubscriptionHandle =>
    createSubscription(
      auditSubscriptions,
      (id) => ({
        id,
        owner,
        runId,
        publish,
      }),
      subscriptionId,
    );

  const replayTimeline = (
    runId: string,
    publish: (event: RunTimelineEnvelope) => boolean,
  ): void => {
    const buffer = getReplayableTimeline(runId);
    for (const event of buffer) {
      if (!publish(event)) {
        break;
      }
    }
  };

  const replayAudit = (runId: string, publish: (event: RunAuditEnvelope) => boolean): void => {
    const buffer = getReplayableAudit(runId);
    for (const event of buffer) {
      if (!publish(event)) {
        break;
      }
    }
  };

  const queueRunCreatedProjection = (runId: string): void => {
    const timer = setTimeout(() => {
      try {
        refreshManifestIndexEntry(runId);
        publishMutationResult(runId, {
          summary: getProjectedSummary(runId),
          detail: getProjectedDetail(runId),
        });
        queueScheduleEvaluation?.(runId);
      } catch (error) {
        publishScheduleRecovery(runId, error);
      }
    }, 0);
    timer.unref?.();
  };

  const removeSubscriptionsByOwner = (owner: object): void => {
    for (const [id, subscription] of summarySubscriptions) {
      if (subscription.owner === owner) {
        summarySubscriptions.delete(id);
      }
    }
    for (const [id, subscription] of detailSubscriptions) {
      if (subscription.owner === owner) {
        detailSubscriptions.delete(id);
      }
    }
    for (const [id, subscription] of timelineSubscriptions) {
      if (subscription.owner === owner) {
        timelineSubscriptions.delete(id);
      }
    }
    for (const [id, subscription] of auditSubscriptions) {
      if (subscription.owner === owner) {
        auditSubscriptions.delete(id);
      }
    }
  };

  const executeManagedRun = async (
    kind: "start" | "resume",
    startManagedRun: (
      emitEvent: (event: RunEvent) => void,
      abortSignal: AbortSignal,
      emitAuditEnvelope: (envelope: RunAuditEnvelope) => void,
    ) => Promise<{ runId: string }>,
  ): Promise<{ runId: string }> => {
    const finish = startDebugPerfTimer("daemon.managed_run.start", { kind });
    let finished = false;
    const finalize = (fields: Record<string, unknown>) => {
      if (finished) {
        return;
      }
      finished = true;
      finish(fields);
    };
    const abortController = new AbortController();
    let runId: string | undefined;
    let resolveRunId: ((value: string) => void) | undefined;
    let rejectRunId: ((reason: unknown) => void) | undefined;
    let resolveDone: (() => void) | undefined;
    const runIdPromise = new Promise<string>((resolve, reject) => {
      resolveRunId = resolve;
      rejectRunId = reject;
    });
    const done = new Promise<void>((resolve) => {
      resolveDone = resolve;
    });

    void startManagedRun(
      (event) => {
        if ((event.type === "run_started" || event.type === "run_initialized") && !runId) {
          runId = event.runId;
          activeRuns.set(runId, createActiveRunRecord(abortController, done, runId));
          resolveRunId?.(runId);
        }
        const resolvedRunId =
          runId ?? (event.type === "run_finished" ? event.summary.runId : undefined);
        if (resolvedRunId) {
          publishTimeline(resolvedRunId, event);
          if (
            event.type === "run_started" ||
            event.type === "retrying" ||
            event.type === "run_aborted" ||
            event.type === "run_finished"
          ) {
            const previous = activeRuns.get(resolvedRunId)?.detail ?? null;
            const current = getProjectedDetail(resolvedRunId);
            publishMutationResult(resolvedRunId, {
              summary: getProjectedSummary(resolvedRunId),
              detail: current,
              publishDependentSummaries: shouldPublishDependentSummaries(previous, current),
              publishDependentDetails: shouldPublishDependentDetails(previous, current),
            });
          }
        }
      },
      abortController.signal,
      (envelope) => {
        publishAudit(envelope);
        if (envelope.event.type === "run.created") {
          queueRunCreatedProjection(envelope.runId);
        }
      },
    )
      .then((outcome) => {
        if (!runId) {
          runId = outcome.runId;
          activeRuns.set(runId, createActiveRunRecord(abortController, done, runId));
          resolveRunId?.(runId);
        }
      })
      .catch((err) => {
        finalize({
          kind,
          runId: runId ?? null,
          error: err instanceof Error ? err.message : String(err),
        });
        if (!runId) {
          rejectRunId?.(err);
          return;
        }
        const event: RunTimelineEvent = {
          type: "backend_notice",
          text: `task-runner: ${err instanceof Error ? err.message : String(err)}\n`,
        };
        publishTimeline(runId, event);
      })
      .finally(() => {
        if (runId) {
          const active = activeRuns.get(runId);
          const previous = active?.detail ?? null;
          if (active && active.auditBuffer.length > 0) {
            rememberRecentAuditBuffer(runId, active.auditBuffer);
          }
          if (active && active.timelineBuffer.length > 0) {
            rememberRecentTimelineBuffer(runId, active.timelineBuffer);
          }
          activeRuns.delete(runId);
          lastTimelineCursorByRun.delete(runId);
          const current = getProjectedDetail(runId);
          publishMutationResult(runId, {
            summary: getProjectedSummary(runId),
            detail: current,
            publishDependentSummaries: shouldPublishDependentSummaries(previous, current),
            publishDependentDetails: shouldPublishDependentDetails(previous, current),
          });
          queueScheduleEvaluation?.(runId);
        }
        resolveDone?.();
      });

    const result = { runId: await runIdPromise };
    finalize({ kind, runId: result.runId });
    return result;
  };

  const abortRun = (target: string): { runId: string; accepted: true } => {
    const active = activeRuns.get(target);
    if (!active) {
      throw new ConflictError(`run ${target} is not active in this daemon process`);
    }
    active.abortController.abort();
    return { runId: target, accepted: true };
  };

  operations = createDaemonOperations({
    ...app,
    getRun: getDaemonRun,
    getRunList: getDaemonRunList,
    getRunAuditHistory: getProjectedAuditHistory,
    getRunTimelineHistory: getProjectedTimelineHistory,
    getAttachment,
    getAttachmentList,
    initRun: async (request) => {
      const run = await app.initRun({
        ...request,
        execution: daemonExecution(daemonInstanceId),
      });
      publishRunProjections(run.runId);
      queueScheduleEvaluation?.(run.runId);
      return run;
    },
    readyRun: (target, input = {}) => {
      const mutation = applyPublishedMutation(
        target,
        () => app.readyRun(target, input, mutationAuditContext, publishAudit),
        {
          inferDependentFanout: true,
        },
      );
      queueAutoStartDependencyRun(mutation.result.runId, {
        summary: mutation.summary,
        detail: mutation.detail,
      });
      return mutation.result;
    },
    setRunSchedule: (target, input) =>
      withPublishedMutation(target, () =>
        app.setRunSchedule(target, input, mutationAuditContext, publishAudit),
      ),
    clearRunSchedule: (target) =>
      withPublishedMutation(target, () =>
        app.clearRunSchedule(target, mutationAuditContext, publishAudit),
      ),
    setRunScheduleEnabled: (target, input) =>
      withPublishedMutation(target, () =>
        app.setRunScheduleEnabled(target, input, mutationAuditContext, publishAudit),
      ),
    archive: (target) =>
      withPublishedMutation(target, () => app.archive(target, mutationAuditContext, publishAudit), {
        inferDependentFanout: true,
      }),
    unarchive: (target) =>
      withPublishedMutation(
        target,
        () => app.unarchive(target, mutationAuditContext, publishAudit),
        {
          inferDependentFanout: true,
        },
      ),
    deleteArchivedRun: (target) => {
      const result = app.deleteArchivedRun(target);
      publishRunDeletion(result.runId);
      return result;
    },
    renameRun: (target, input) =>
      withPublishedMutationAsync(
        target,
        () => app.renameRun(target, input, mutationAuditContext, publishAudit),
        {
          inferDependentFanout: true,
        },
      ),
    updateRunNote: (target, input) =>
      withPublishedMutation(target, () => app.updateRunNote(target, input)),
    updateRunPinned: (target, input) =>
      withPublishedMutation(target, () => app.updateRunPinned(target, input)),
    updateRunBackendSession: (target, input) =>
      withPublishedDetailMutation(target, () =>
        app.updateRunBackendSession(target, input, mutationAuditContext, publishAudit),
      ),
    clearBackendSession: (target) =>
      withPublishedDetailMutation(target, () =>
        app.clearBackendSession(target, mutationAuditContext, publishAudit),
      ),
    addDependency: (target, dependencyRunId) =>
      withPublishedMutation(target, () => app.addDependency(target, dependencyRunId)),
    removeDependency: (target, dependencyRunId) =>
      withPublishedMutation(target, () => app.removeDependency(target, dependencyRunId)),
    clearDependencies: (target) =>
      withPublishedMutation(target, () => app.clearDependencies(target)),
    addRunAttachmentFromStream: (target, input) =>
      withPublishedMutationAsync(target, () => app.addRunAttachmentFromStream(target, input)),
    removeRunAttachment: (target, attachmentId) =>
      withPublishedMutation(target, () => app.removeRunAttachment(target, attachmentId)),
    reset: (target) =>
      withPublishedMutation(target, () => app.reset(target, mutationAuditContext, publishAudit), {
        inferDependentFanout: true,
      }),
    updateTask: (target, taskId, updates) =>
      withPublishedMutationAsync(
        target,
        () => app.updateTask(target, taskId, updates, mutationAuditContext, publishAudit),
        {
          inferDependentFanout: true,
        },
      ),
    appendNotes: (target, taskId, text) =>
      withPublishedMutationAsync(target, () =>
        app.appendNotes(target, taskId, text, mutationAuditContext, publishAudit),
      ),
    createTask: (target, input) =>
      withPublishedMutationAsync(
        target,
        () => app.createTask(target, input, mutationAuditContext, publishAudit),
        {
          inferDependentFanout: true,
        },
      ),
    daemonInfo: {
      daemonInstanceId,
      pid: process.pid,
      listenUrl,
      version,
      startedAt,
    },
    startManagedRun: (request) =>
      executeManagedRun("start", (emitEvent, abortSignal, emitAuditEnvelope) =>
        app.startRun({
          ...request,
          execution: daemonExecution(daemonInstanceId),
          abortSignal,
          emitEvent,
          emitAuditEnvelope,
        }),
      ),
    resumeManagedRun: (request) =>
      executeManagedRun("resume", (emitEvent, abortSignal, emitAuditEnvelope) =>
        app.resumeRun({
          ...request,
          execution: daemonExecution(daemonInstanceId),
          abortSignal,
          emitEvent,
          emitAuditEnvelope,
        }),
      ),
    abortRun,
  });

  queueReadyDependencyAutoStartSweep = () => {
    const eligibleRunIds = Array.from(manifestEntriesByRunId.values())
      .filter(
        (entry) => entry.manifest.status === "ready" && entry.manifest.dependencyRunIds.length > 0,
      )
      .map((entry) => entry.manifest.runId);
    for (const runId of eligibleRunIds) {
      queueAutoStartDependencyRun(runId);
    }
  };
  rebuildManifestIndex();
  void evaluateSchedules(null, { startup: true });

  const eventLoopHistogram = debugPerfEnabled() ? monitorEventLoopDelay({ resolution: 20 }) : null;
  let previousEventLoopUtilization = debugPerfEnabled()
    ? performance.eventLoopUtilization()
    : undefined;
  if (eventLoopHistogram) {
    eventLoopHistogram.enable();
  }
  const eventLoopInterval =
    eventLoopHistogram && previousEventLoopUtilization
      ? setInterval(() => {
          const currentUtilization = performance.eventLoopUtilization(previousEventLoopUtilization);
          previousEventLoopUtilization = performance.eventLoopUtilization();
          debugPerfLog("daemon.event_loop", {
            utilization: roundMetric(currentUtilization.utilization),
            active: roundMetric(currentUtilization.active),
            idle: roundMetric(currentUtilization.idle),
            minMs: roundMetric(eventLoopHistogram.min / 1_000_000),
            meanMs: roundMetric(eventLoopHistogram.mean / 1_000_000),
            maxMs: roundMetric(eventLoopHistogram.max / 1_000_000),
            p99Ms: roundMetric(eventLoopHistogram.percentile(99) / 1_000_000),
          });
          eventLoopHistogram.reset();
        }, readDebugPerfIntervalMs())
      : null;
  eventLoopInterval?.unref();

  const httpServer = createServer((req, res) => {
    const pathname = new URL(req.url ?? "/", httpBaseUrl).pathname;

    if (pathname === "/app-config.json") {
      res.setHeader("cache-control", "no-cache");
      res.setHeader("content-type", "application/json; charset=utf-8");
      res.end(JSON.stringify(deriveAppRuntimeConfig()));
      return;
    }

    if (pathname === "/api" || pathname.startsWith("/api/")) {
      void handleHttpRequest(req, res, {
        operations,
        httpBaseUrl,
        subscribeRunSummaries: (publish) => subscribeRunSummaries(res, publish).unsubscribe,
        subscribeRunDetail: (runId, publish) => subscribeRunDetail(res, runId, publish).unsubscribe,
        subscribeRunAudit: (runId, publish) => {
          const subscription = subscribeRunAudit(res, runId, publish);
          replayAudit(runId, publish);
          return subscription.unsubscribe;
        },
        subscribeRunTimeline: (runId, publish) => {
          const subscription = subscribeRunTimeline(res, runId, publish);
          replayTimeline(runId, publish);
          return subscription.unsubscribe;
        },
      });
      return;
    }

    serveFrontendRequest(req, res, pathname);
  });
  const wsServer = new WebSocketServer({ server: httpServer, path });

  httpServer.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => {
      sockets.delete(socket);
    });
  });

  await new Promise<void>((resolve, reject) => {
    const onListening = () => {
      cleanup();
      resolve();
    };
    const onError = (error: Error) => {
      cleanup();
      void new Promise<void>((closeResolve) => wsServer.close(() => closeResolve()));
      reject(error);
    };
    const cleanup = () => {
      httpServer.off("listening", onListening);
      httpServer.off("error", onError);
    };
    httpServer.once("listening", onListening);
    httpServer.once("error", onError);
    httpServer.listen(port, host);
  });

  const handleRpcRequest = async (ws: WebSocket, request: JsonRpcRequest): Promise<void> => {
    try {
      const params = request.params;
      switch (request.method) {
        case "daemon.info":
          sendJson(ws, resultResponse(request.id, operations.readDaemonInfo().daemon));
          return;
        case "runs.list": {
          const parsed = params ? parseRunsListParams(params, "runs.list params") : {};
          sendJson(ws, resultResponse(request.id, operations.listRuns(parsed)));
          return;
        }
        case "runs.get":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getRun(
                requiredRunIdString(asRecord(params, "runs.get params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.timelineHistory":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getRunTimelineHistory(
                requiredRunIdString(
                  asRecord(params, "runs.timelineHistory params").target,
                  "target",
                ),
              ),
            ),
          );
          return;
        case "runs.brief":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getRunBrief(
                requiredRunIdString(asRecord(params, "runs.brief params").target, "target"),
              ),
            ),
          );
          return;
        case "tasks.list":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.listTasks(
                requiredString(asRecord(params, "tasks.list params").target, "target"),
              ),
            ),
          );
          return;
        case "tasks.get": {
          const parsed = asRecord(params, "tasks.get params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getTask(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
              ),
            ),
          );
          return;
        }
        case "agents.list":
          sendJson(ws, resultResponse(request.id, operations.listAgents()));
          return;
        case "agents.get": {
          const parsed = asRecord(params, "agents.get params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getAgent({
                target: requiredString(parsed.target, "target"),
                cwd: optionalString(parsed.cwd, "cwd"),
              }),
            ),
          );
          return;
        }
        case "assignments.list":
          sendJson(ws, resultResponse(request.id, operations.listAssignments()));
          return;
        case "assignments.get": {
          const parsed = asRecord(params, "assignments.get params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getAssignment({
                target: requiredString(parsed.target, "target"),
                cwd: optionalString(parsed.cwd, "cwd"),
              }),
            ),
          );
          return;
        }
        case "launchers.list":
          sendJson(ws, resultResponse(request.id, operations.listLaunchers()));
          return;
        case "launchers.get": {
          const parsed = asRecord(params, "launchers.get params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.getLauncher({
                target: requiredString(parsed.target, "target"),
                cwd: optionalString(parsed.cwd, "cwd"),
              }),
            ),
          );
          return;
        }
        case "runs.ready": {
          const parsed = parseRunReadyParams(params, "runs.ready params");
          sendJson(ws, resultResponse(request.id, operations.readyRun(parsed)));
          return;
        }
        case "runs.setSchedule": {
          const parsed = parseRunScheduleParams(params, "runs.setSchedule params");
          sendJson(ws, resultResponse(request.id, operations.setRunSchedule(parsed)));
          return;
        }
        case "runs.clearSchedule":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.clearRunSchedule(
                requiredString(asRecord(params, "runs.clearSchedule params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.enableSchedule":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.setRunScheduleEnabled(
                requiredString(asRecord(params, "runs.enableSchedule params").target, "target"),
                true,
              ),
            ),
          );
          return;
        case "runs.disableSchedule":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.setRunScheduleEnabled(
                requiredString(asRecord(params, "runs.disableSchedule params").target, "target"),
                false,
              ),
            ),
          );
          return;
        case "runs.archive":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.archiveRun(
                requiredString(asRecord(params, "runs.archive params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.unarchive":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.unarchiveRun(
                requiredString(asRecord(params, "runs.unarchive params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.reset":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.resetRun(
                requiredString(asRecord(params, "runs.reset params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.delete":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.deleteRun(
                requiredString(asRecord(params, "runs.delete params").target, "target"),
              ),
            ),
          );
          return;
        case "runs.setName": {
          const parsed = parseRunSetNameParams(params, "runs.setName params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await operations.setRunName(parsed.target, {
                name: parsed.name,
              }),
            ),
          );
          return;
        }
        case "runs.setNote": {
          const parsed = parseRunSetNoteParams(params, "runs.setNote params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.setRunNote(parsed.target, {
                note: parsed.note,
              }),
            ),
          );
          return;
        }
        case "runs.setPinned": {
          const parsed = parseRunSetPinnedParams(params, "runs.setPinned params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.setRunPinned(parsed.target, {
                pinned: parsed.pinned,
              }),
            ),
          );
          return;
        }
        case "runs.setBackendSession": {
          const parsed = parseRunSetBackendSessionParams(params, "runs.setBackendSession params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.setRunBackendSession(parsed.target, {
                backendSessionId: parsed.backendSessionId,
              }),
            ),
          );
          return;
        }
        case "runs.clearBackendSession":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.clearBackendSession(
                requiredString(
                  asRecord(params, "runs.clearBackendSession params").target,
                  "target",
                ),
              ),
            ),
          );
          return;
        case "runs.addDependency": {
          const parsed = asRecord(params, "runs.addDependency params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.addDependency(
                requiredString(parsed.target, "target"),
                requiredRunIdString(parsed.dependencyRunId, "dependencyRunId"),
              ),
            ),
          );
          return;
        }
        case "runs.removeDependency": {
          const parsed = asRecord(params, "runs.removeDependency params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.removeDependency(
                requiredString(parsed.target, "target"),
                requiredRunIdString(parsed.dependencyRunId, "dependencyRunId"),
              ),
            ),
          );
          return;
        }
        case "runs.clearDependencies":
          sendJson(
            ws,
            resultResponse(
              request.id,
              operations.clearDependencies(
                requiredString(asRecord(params, "runs.clearDependencies params").target, "target"),
              ),
            ),
          );
          return;
        case "tasks.set": {
          const parsed = asRecord(params, "tasks.set params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await operations.updateTask(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
                {
                  status: optionalEnum(parsed.status, "status", VALID_STATUSES),
                  notes: optionalString(parsed.notes, "notes"),
                },
              ),
            ),
          );
          return;
        }
        case "tasks.appendNotes": {
          const parsed = asRecord(params, "tasks.appendNotes params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await operations.appendTaskNotes(
                requiredString(parsed.target, "target"),
                requiredString(parsed.taskId, "taskId"),
                requiredString(parsed.text, "text"),
              ),
            ),
          );
          return;
        }
        case "tasks.add": {
          const parsed = asRecord(params, "tasks.add params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await operations.createTask(requiredString(parsed.target, "target"), {
                title: requiredString(parsed.title, "title"),
                body: optionalString(parsed.body, "body"),
              }),
            ),
          );
          return;
        }
        case "runs.init": {
          const parsed = parseCliStartRunParams(params, "runs.init params");
          sendJson(ws, resultResponse(request.id, await operations.initCliRun(parsed)));
          return;
        }
        case "runs.start": {
          const parsed = parseCliStartRunParams(params, "runs.start params");
          sendJson(ws, resultResponse(request.id, await operations.startCliRun(parsed)));
          return;
        }
        case "runs.resume": {
          const parsed = parseResumeRunParams(params, "runs.resume params");
          sendJson(ws, resultResponse(request.id, await operations.resumeRun(parsed)));
          return;
        }
        case "runs.abort": {
          const target = requiredString(asRecord(params, "runs.abort params").target, "target");
          sendJson(ws, resultResponse(request.id, operations.abortRun(target)));
          return;
        }
        case "events.subscribe": {
          const parsed: Record<string, unknown> = params
            ? asRecord(params, "events.subscribe params")
            : {};
          const channel = parseRunEventChannel(parsed.channel);
          const runId = optionalString(parsed.runId, "runId");
          const subscriptionId = `sub-${shortId()}`;
          let subscription: { subscriptionId: string; unsubscribe(): void } | undefined;
          const sendNotification = (
            method: "run.summary" | "run.detail" | "run.timeline" | "run.audit",
            notificationParams:
              | RunSummaryNotificationParams
              | RunDetailNotificationParams
              | RunTimelineNotificationParams
              | RunAuditNotificationParams,
          ): boolean => {
            if (ws.readyState !== WebSocket.OPEN) {
              return false;
            }
            try {
              ws.send(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method,
                  params: notificationParams,
                }),
              );
              return true;
            } catch {
              return false;
            }
          };
          switch (channel) {
            case "run_summary":
              if (runId !== undefined) {
                throw new RequestValidationError("runId must be omitted for channel run_summary");
              }
              subscription = subscribeRunSummaries(
                ws,
                (summary) =>
                  sendNotification(
                    "run.summary",
                    summary.type === "summary_upsert"
                      ? {
                          subscriptionId,
                          type: "summary_upsert",
                          summary: summary.summary,
                        }
                      : {
                          subscriptionId,
                          type: "summary_removed",
                          runId: summary.runId,
                        },
                  ),
                subscriptionId,
              );
              break;
            case "run_detail": {
              const requiredRunId = requiredRunIdString(parsed.runId, "runId");
              operations.getRun(requiredRunId);
              subscription = subscribeRunDetail(
                ws,
                requiredRunId,
                (detail) =>
                  sendNotification("run.detail", {
                    subscriptionId,
                    runId: requiredRunId,
                    detail: detail.detail,
                  }),
                subscriptionId,
              );
              break;
            }
            case "run_timeline": {
              const requiredRunId = requiredRunIdString(parsed.runId, "runId");
              operations.getRun(requiredRunId);
              const publish = (envelope: RunTimelineEnvelope) =>
                sendNotification("run.timeline", {
                  subscriptionId,
                  runId: requiredRunId,
                  cursor: envelope.cursor,
                  event: envelope.event,
                });
              subscription = subscribeRunTimeline(ws, requiredRunId, publish, subscriptionId);
              sendJson(
                ws,
                resultResponse(request.id, { subscriptionId: subscription.subscriptionId }),
              );
              replayTimeline(requiredRunId, publish);
              break;
            }
            case "run_audit": {
              const requiredRunId = requiredRunIdString(parsed.runId, "runId");
              operations.getRun(requiredRunId);
              const publish = (envelope: RunAuditEnvelope) =>
                sendNotification("run.audit", {
                  subscriptionId,
                  runId: requiredRunId,
                  cursor: envelope.cursor,
                  event: envelope.event,
                });
              subscription = subscribeRunAudit(ws, requiredRunId, publish, subscriptionId);
              sendJson(
                ws,
                resultResponse(request.id, { subscriptionId: subscription.subscriptionId }),
              );
              replayAudit(requiredRunId, publish);
              break;
            }
          }
          if (channel !== "run_timeline" && channel !== "run_audit") {
            sendJson(
              ws,
              resultResponse(request.id, { subscriptionId: subscription.subscriptionId }),
            );
          }
          return;
        }
        case "events.unsubscribe": {
          const parsed = asRecord(params, "events.unsubscribe params");
          const subscriptionId = requiredString(parsed.subscriptionId, "subscriptionId");
          summarySubscriptions.delete(subscriptionId);
          detailSubscriptions.delete(subscriptionId);
          timelineSubscriptions.delete(subscriptionId);
          auditSubscriptions.delete(subscriptionId);
          sendJson(ws, resultResponse(request.id, { unsubscribed: true }));
          return;
        }
        default:
          sendJson(
            ws,
            rpcErrorResponse(request.id, -32601, `unknown daemon method: ${request.method}`),
          );
      }
    } catch (err) {
      try {
        sendJson(ws, errorResponse(request.id, err));
      } catch {
        // Ignore disconnect races while attempting to report an error.
      }
    }
  };

  wsServer.on("connection", (ws) => {
    wsClients.add(ws);
    ws.on("message", (payload) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(payload.toString()) as unknown;
      } catch {
        sendJson(ws, rpcErrorResponse(null, -32700, "parse error"));
        return;
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        sendJson(ws, rpcErrorResponse(null, -32600, "invalid request"));
        return;
      }
      const request = parsed as Partial<JsonRpcRequest>;
      if (request.jsonrpc !== "2.0") {
        sendJson(ws, rpcErrorResponse(request.id ?? null, -32600, "invalid request"));
        return;
      }
      if (request.id === undefined || typeof request.method !== "string") {
        sendJson(ws, rpcErrorResponse(request.id ?? null, -32600, "invalid request"));
        return;
      }
      void handleRpcRequest(ws, request as JsonRpcRequest);
    });

    ws.on("close", () => {
      wsClients.delete(ws);
      removeSubscriptionsByOwner(ws);
    });
  });

  return {
    listenUrl,
    httpBaseUrl,
    startedAt,
    close: async () => {
      const wsClosePromise = new Promise<void>((resolve) => wsServer.close(() => resolve()));
      const httpClosePromise = new Promise<void>((resolve, reject) => {
        httpServer.close((err) => {
          if (err && !(err instanceof Error && err.message === "Server is not running.")) {
            reject(err);
            return;
          }
          resolve();
        });
      });
      const active = [...activeRuns.values()];
      for (const record of active) {
        record.abortController.abort();
      }
      await Promise.allSettled(active.map((record) => record.done));
      summarySubscriptions.clear();
      detailSubscriptions.clear();
      timelineSubscriptions.clear();
      auditSubscriptions.clear();
      for (const record of recentTimelineBuffers.values()) {
        clearTimeout(record.cleanupTimer);
      }
      recentTimelineBuffers.clear();
      for (const record of recentAuditBuffers.values()) {
        clearTimeout(record.cleanupTimer);
      }
      recentAuditBuffers.clear();
      for (const timer of scheduleTimers.values()) {
        clearTimeout(timer);
      }
      scheduleTimers.clear();
      for (const ws of wsClients) {
        ws.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      if (eventLoopInterval) {
        clearInterval(eventLoopInterval);
      }
      eventLoopHistogram?.disable();
      await Promise.all([wsClosePromise, httpClosePromise]);
    },
  };
}
