import { readFileSync } from "node:fs";
import { createServer } from "node:http";
import { type Socket, createServer as createNetServer } from "node:net";
import {
  addDependency,
  addRunAttachmentFromStream,
  appendNotes,
  archive,
  clearBackendSession,
  clearDependencies,
  createTask,
  deleteArchivedRun,
  getAttachment,
  getAttachmentList,
  getDefinition,
  getDefinitionList,
  getRun,
  getRunBrief,
  getRunList,
  getRunSummary,
  getRunTimelineHistory,
  getTask,
  getTaskList,
  initRun,
  removeDependency,
  removeRunAttachment,
  renameRun,
  reset,
  resumeRun,
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
import { isTerminalStatus, toRunDetail } from "@task-runner/core/contracts/runs.js";
import {
  ConflictError,
  refreshRunSnapshotAfterTaskStateSettles,
} from "@task-runner/core/core/commands/service.js";
import {
  resolveDependencies,
  resolveDependentsFromManifests,
} from "@task-runner/core/core/run/dependencies.js";
import {
  type ListedRunManifest,
  type RunManifest,
  RunNotFoundError,
  findRunManifestsById,
  listRunManifests,
  resolveResumeTarget,
} from "@task-runner/core/core/run/manifest.js";
import type { RunEvent } from "@task-runner/core/core/run/run-loop.js";
import { withTaskStateLock } from "@task-runner/core/core/run/workspace-state.js";
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
  type RunDetailNotificationParams,
  type RunSummaryNotificationParams,
  type RunTimelineNotificationParams,
} from "./protocol.js";
import {
  RequestValidationError,
  asRecord,
  optionalEnum,
  optionalOverrides,
  optionalString,
  parseRunSetBackendSessionParams,
  parseRunSetNameParams,
  parseRunSetNoteParams,
  parseRunSetPinnedParams,
  parseRunsListParams,
  parseStartRunParams,
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

interface ActiveRunRecord {
  abortController: AbortController;
  done: Promise<void>;
  detail: RunDetail | null;
  timelineBuffer: RunTimelineEnvelope[];
  nextCursor: number;
  currentAttempt: RunTimelineAttempt | null;
}

interface RecentTimelineRecord {
  events: RunTimelineEnvelope[];
  cleanupTimer: ReturnType<typeof setTimeout>;
}

interface SubscriptionHandle {
  subscriptionId: string;
  unsubscribe(): void;
}

const MAX_TIMELINE_BUFFER_EVENTS = 1_000;
const COMPLETED_TIMELINE_BUFFER_TTL_MS = 5_000;

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
        attempt: envelope.event.attempt,
        sessionIndex: envelope.event.sessionIndex,
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
  const activeRuns = new Map<string, ActiveRunRecord>();
  const manifestEntriesByRunId = new Map<string, ListedRunManifest>();
  const dependentRunIdsByRunId = new Map<string, Set<string>>();
  let manifestIndexInitialized = false;
  const recentTimelineBuffers = new Map<string, RecentTimelineRecord>();
  const sockets = new Set<Socket>();
  const wsClients = new Set<WebSocket>();

  const app: DaemonHandlers = {
    getRun,
    getRunBrief,
    getRunList,
    getRunSummary,
    getRunTimelineHistory,
    getAttachment,
    getAttachmentList,
    getTask,
    getTaskList,
    getDefinition,
    getDefinitionList,
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
    addRunAttachmentFromStream,
    removeRunAttachment,
    reset,
    updateTask,
    appendNotes,
    createTask,
    initRun,
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
    try {
      return getDaemonRunSummary(runId);
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        return null;
      }
      throw err;
    }
  };

  const getProjectedDetail = (runId: string): RunDetail | null => {
    try {
      return getDaemonRun(runId);
    } catch (err) {
      if (err instanceof RunNotFoundError) {
        return null;
      }
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

  const getReplayableTimeline = (runId: string): RunTimelineEnvelope[] => {
    const active = activeRuns.get(runId);
    if (active) {
      return active.timelineBuffer;
    }
    return recentTimelineBuffers.get(runId)?.events ?? [];
  };

  const getProjectedTimelineHistory = (runId: string): RunTimelineHistory => {
    const history = app.getRunTimelineHistory(runId);
    const active = activeRuns.get(runId);
    if (!active) {
      return history;
    }
    return {
      runId,
      attempts: active.currentAttempt
        ? [...history.attempts, { ...active.currentAttempt }]
        : history.attempts,
      lastCursor: active.nextCursor,
    };
  };

  const createActiveRunRecord = (
    abortController: AbortController,
    done: Promise<void>,
    runId: string,
  ): ActiveRunRecord => {
    clearRecentTimelineBuffer(runId);
    return {
      abortController,
      done,
      detail: getProjectedDetail(runId),
      timelineBuffer: [],
      nextCursor: lastTimelineCursorByRun.get(runId) ?? 0,
      currentAttempt: null,
    };
  };

  const parseRunEventChannel = (value: unknown): "run_summary" | "run_detail" | "run_timeline" => {
    const channel = requiredString(value, "channel");
    switch (channel) {
      case "run_summary":
      case "run_detail":
      case "run_timeline":
        return channel;
      default:
        throw new RequestValidationError(
          'channel must be one of "run_summary", "run_detail", or "run_timeline"',
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

  const publishSummary = (summary: RunSummary): void => {
    const payload: RunSummaryStreamEvent = {
      type: "summary_upsert",
      summary,
    };
    for (const [id, subscription] of summarySubscriptions) {
      const keep = subscription.publish(payload);
      if (!keep) {
        summarySubscriptions.delete(id);
      }
    }
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
    const payload: RunDetailStreamEvent = {
      type: "detail_updated",
      detail,
    };
    for (const [id, subscription] of detailSubscriptions) {
      if (subscription.runId !== detail.runId) {
        continue;
      }
      const keep = subscription.publish(payload);
      if (!keep) {
        detailSubscriptions.delete(id);
      }
    }
  };

  const publishTimeline = (runId: string, event: RunTimelineEvent): void => {
    const active = activeRuns.get(runId);
    if (!active) {
      return;
    }
    const cursor = active.nextCursor + 1;
    active.nextCursor = cursor;
    lastTimelineCursorByRun.set(runId, cursor);
    const envelope: RunTimelineEnvelope = { runId, cursor, event };
    bufferTimelineEvent(active, envelope);
    for (const [id, subscription] of timelineSubscriptions) {
      if (subscription.runId !== runId) {
        continue;
      }
      const keep = subscription.publish(envelope);
      if (!keep) {
        timelineSubscriptions.delete(id);
      }
    }
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
      if (options.publishDependentSummaries) {
        const dependentSummary = getProjectedSummary(dependentRunId);
        if (dependentSummary) {
          publishSummary(dependentSummary);
        }
      }
      if (options.publishDependentDetails) {
        const dependentDetail = getProjectedDetail(dependentRunId);
        if (dependentDetail) {
          publishDetail(dependentDetail);
        }
      }
    }
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

  const withPublishedMutation = <T>(
    runId: string,
    mutate: () => T,
    options: {
      inferDependentFanout?: boolean;
    } = {},
  ): T => {
    const previous = options.inferDependentFanout ? getProjectedDetail(runId) : null;
    const result = mutate();
    const current = getProjectedDetail(runId);
    const summary = getProjectedSummary(runId);
    publishMutationResult(runId, {
      summary,
      detail: current,
      publishDependentSummaries: shouldPublishDependentSummaries(previous, current),
      publishDependentDetails: shouldPublishDependentDetails(previous, current),
    });
    return result;
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
  };

  const executeManagedRun = async (
    startManagedRun: (
      emitEvent: (event: RunEvent) => void,
      abortSignal: AbortSignal,
    ) => Promise<{ runId: string }>,
  ): Promise<{ runId: string }> => {
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

    void startManagedRun((event) => {
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
    }, abortController.signal)
      .then((outcome) => {
        if (!runId) {
          runId = outcome.runId;
          activeRuns.set(runId, createActiveRunRecord(abortController, done, runId));
          resolveRunId?.(runId);
        }
      })
      .catch((err) => {
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
        }
        resolveDone?.();
      });

    return { runId: await runIdPromise };
  };

  const abortRun = (target: string): { runId: string; accepted: true } => {
    const active = activeRuns.get(target);
    if (!active) {
      throw new ConflictError(`run ${target} is not active in this daemon process`);
    }
    active.abortController.abort();
    return { runId: target, accepted: true };
  };

  const operations = createDaemonOperations({
    ...app,
    getRun: getDaemonRun,
    getRunList: getDaemonRunList,
    getRunTimelineHistory: getProjectedTimelineHistory,
    getAttachment,
    getAttachmentList,
    initRun: async (request) => {
      const run = await app.initRun({
        ...request,
        execution: daemonExecution(daemonInstanceId),
      });
      publishRunProjections(run.runId);
      return run;
    },
    archive: (target) =>
      withPublishedMutation(target, () => app.archive(target, mutationAuditContext), {
        inferDependentFanout: true,
      }),
    unarchive: (target) =>
      withPublishedMutation(target, () => app.unarchive(target, mutationAuditContext), {
        inferDependentFanout: true,
      }),
    deleteArchivedRun: (target) => {
      const result = app.deleteArchivedRun(target);
      publishRunDeletion(result.runId);
      return result;
    },
    renameRun: (target, input) =>
      withPublishedMutationAsync(target, () => app.renameRun(target, input, mutationAuditContext), {
        inferDependentFanout: true,
      }),
    updateRunNote: (target, input) =>
      withPublishedMutation(target, () => app.updateRunNote(target, input)),
    updateRunPinned: (target, input) =>
      withPublishedMutation(target, () => app.updateRunPinned(target, input)),
    updateRunBackendSession: (target, input) =>
      withPublishedDetailMutation(target, () =>
        app.updateRunBackendSession(target, input, mutationAuditContext),
      ),
    clearBackendSession: (target) =>
      withPublishedDetailMutation(target, () =>
        app.clearBackendSession(target, mutationAuditContext),
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
      withPublishedMutation(target, () => app.reset(target, mutationAuditContext), {
        inferDependentFanout: true,
      }),
    updateTask: (target, taskId, updates) =>
      withPublishedMutationAsync(
        target,
        () => app.updateTask(target, taskId, updates, mutationAuditContext),
        {
          inferDependentFanout: true,
        },
      ),
    appendNotes: (target, taskId, text) =>
      withPublishedMutationAsync(target, () =>
        app.appendNotes(target, taskId, text, mutationAuditContext),
      ),
    createTask: (target, input) =>
      withPublishedMutationAsync(
        target,
        () => app.createTask(target, input, mutationAuditContext),
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
      executeManagedRun((emitEvent, abortSignal) =>
        app.startRun({
          ...request,
          execution: daemonExecution(daemonInstanceId),
          abortSignal,
          emitEvent,
        }),
      ),
    resumeManagedRun: (request) =>
      executeManagedRun((emitEvent, abortSignal) =>
        app.resumeRun({
          ...request,
          execution: daemonExecution(daemonInstanceId),
          abortSignal,
          emitEvent,
        }),
      ),
    abortRun,
  });

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
          const parsed = parseStartRunParams(params, "runs.init params");
          sendJson(ws, resultResponse(request.id, await operations.initRun(parsed)));
          return;
        }
        case "runs.start": {
          const parsed = parseStartRunParams(params, "runs.start params");
          sendJson(ws, resultResponse(request.id, await operations.startRun(parsed)));
          return;
        }
        case "runs.resume": {
          const parsed = asRecord(params, "runs.resume params");
          sendJson(
            ws,
            resultResponse(
              request.id,
              await operations.resumeRun({
                target: requiredString(parsed.target, "target"),
                overrides: optionalOverrides(parsed.overrides),
              }),
            ),
          );
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
            method: "run.summary" | "run.detail" | "run.timeline",
            notificationParams:
              | RunSummaryNotificationParams
              | RunDetailNotificationParams
              | RunTimelineNotificationParams,
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
          }
          if (channel !== "run_timeline") {
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
      for (const record of recentTimelineBuffers.values()) {
        clearTimeout(record.cleanupTimer);
      }
      recentTimelineBuffers.clear();
      for (const ws of wsClients) {
        ws.terminate();
      }
      for (const socket of sockets) {
        socket.destroy();
      }
      await Promise.all([wsClosePromise, httpClosePromise]);
    },
  };
}
