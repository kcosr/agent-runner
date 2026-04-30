import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { TaskStatus } from "../../assignment/model.js";
import { appendTextFileDurable } from "../../util/write-file-atomic.js";
import type {
  ManifestStatus,
  RunExecution,
  RunExecutionHostMode,
  RunManifest,
  RunSchedule,
} from "./manifest.js";

export const RUN_EVENTS_FILENAME = "run-events.jsonl";
const RUN_EVENT_SCHEMA_VERSION = 2;

const RUN_EVENT_SOURCES = ["system", "cli", "daemon", "task_command"] as const;
const RUN_EVENT_TYPES = [
  "run.created",
  "run.started",
  "run.resumed",
  "run.ready",
  "run.backend_session_updated",
  "run.hook_recorded",
  "run.attempt_recorded",
  "run.retrying",
  "run.finished",
  "run.aborted",
  "run.resume_rejected",
  "run.reset",
  "run.reconfigured",
  "run.archived",
  "run.unarchived",
  "run.renamed",
  "run.group_changed",
  "run.schedule_set",
  "run.schedule_cleared",
  "run.schedule_enabled",
  "run.schedule_disabled",
  "run.schedule_due",
  "run.schedule_missed",
  "run.schedule_skipped",
  "run.schedule_failed",
  "run.schedule_advanced",
  "run.schedule_consumed",
  "run.queued_resume_message_added",
  "run.queued_resume_message_removed",
  "run.queued_resume_messages_drained",
  "task.added",
  "task.updated",
] as const;

const RUN_EVENT_SHARED_KEYS = new Set([
  "schemaVersion",
  "recordedAt",
  "cursor",
  "runId",
  "eventType",
  "source",
  "hostMode",
  "controllerInstanceId",
  "sessionIndex",
  "attemptNumber",
]);

export type RunEventRecordSource = (typeof RUN_EVENT_SOURCES)[number];
export type RunEventType = (typeof RUN_EVENT_TYPES)[number];

export type BackendSessionUpdateReason =
  | "bootstrap_import"
  | "backend_capture"
  | "passive_set"
  | "passive_clear"
  | "reset_clear";

export type ScheduleDecisionReason =
  | "dependencies_unmet"
  | "overdue_on_startup"
  | "already_active"
  | "archived"
  | "not_ready"
  | "start_failed"
  | "minimum_interval_violation";

export interface RunEventOrigin {
  hostMode: RunExecutionHostMode;
  controllerInstanceId?: string;
}

export interface RunEventWriteContext extends RunEventOrigin {
  source: RunEventRecordSource;
}

interface RunEventBaseRecord {
  recordedAt: string;
  runId: string;
  eventType: RunEventType;
  source: RunEventRecordSource;
  hostMode: RunExecutionHostMode;
  controllerInstanceId?: string;
  sessionIndex?: number;
  attemptNumber?: number;
}

export interface PersistedRunEventV1 extends RunEventBaseRecord {
  schemaVersion: 1;
  [field: string]: unknown;
}

export interface PersistedRunEventV2 extends RunEventBaseRecord {
  schemaVersion: 2;
  cursor: number;
  [field: string]: unknown;
}

export interface RunAuditEvent {
  type: RunEventType;
  recordedAt: string;
  source: RunEventRecordSource;
  hostMode: RunExecutionHostMode;
  controllerInstanceId?: string;
  sessionIndex?: number;
  attemptNumber?: number;
  fields: Record<string, unknown>;
}

export interface RunAuditEnvelope {
  runId: string;
  cursor: number;
  event: RunAuditEvent;
}

export interface RunAuditHistory {
  runId: string;
  events: RunAuditEnvelope[];
  lastCursor: number;
}

interface ReadRunAuditHistoryResult extends RunAuditHistory {
  malformedCount: number;
}

export const EMBEDDED_RUN_EVENT_ORIGIN: RunEventOrigin = {
  hostMode: "embedded",
};

export function runEventsPath(workspaceDir: string): string {
  return join(workspaceDir, RUN_EVENTS_FILENAME);
}

export function runEventOriginFromExecution(execution: RunExecution): RunEventOrigin {
  if (execution.hostMode === "daemon" && execution.controller.kind === "daemon") {
    return {
      hostMode: "daemon",
      controllerInstanceId: execution.controller.daemonInstanceId,
    };
  }
  return EMBEDDED_RUN_EVENT_ORIGIN;
}

function makeRunEventContext(
  source: RunEventRecordSource,
  origin: RunEventOrigin = EMBEDDED_RUN_EVENT_ORIGIN,
): RunEventWriteContext {
  return {
    ...origin,
    source,
  };
}

export function lifecycleRunEventContext(execution: RunExecution): RunEventWriteContext {
  const origin = runEventOriginFromExecution(execution);
  return makeRunEventContext(origin.hostMode === "daemon" ? "daemon" : "system", origin);
}

export function commandRunEventContext(
  origin: RunEventOrigin = EMBEDDED_RUN_EVENT_ORIGIN,
): RunEventWriteContext {
  return makeRunEventContext(origin.hostMode === "daemon" ? "daemon" : "cli", origin);
}

export function systemRunEventContext(
  origin: RunEventOrigin = EMBEDDED_RUN_EVENT_ORIGIN,
): RunEventWriteContext {
  return makeRunEventContext("system", origin);
}

export function taskCommandRunEventContext(
  origin: RunEventOrigin = EMBEDDED_RUN_EVENT_ORIGIN,
): RunEventWriteContext {
  return makeRunEventContext("task_command", origin);
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isRunEventRecordSource(value: unknown): value is RunEventRecordSource {
  return typeof value === "string" && (RUN_EVENT_SOURCES as readonly string[]).includes(value);
}

function isRunEventType(value: unknown): value is RunEventType {
  return typeof value === "string" && (RUN_EVENT_TYPES as readonly string[]).includes(value);
}

function isPositiveInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value > 0;
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return (
    value === undefined || (typeof value === "number" && Number.isInteger(value) && value >= 0)
  );
}

function parsePersistedRunEventV2(value: unknown): PersistedRunEventV2 | null {
  if (!isObjectRecord(value)) {
    return null;
  }
  if (value.schemaVersion !== 2) {
    return null;
  }
  if (typeof value.recordedAt !== "string") {
    return null;
  }
  if (!isPositiveInteger(value.cursor)) {
    return null;
  }
  if (typeof value.runId !== "string") {
    return null;
  }
  if (!isRunEventType(value.eventType)) {
    return null;
  }
  if (!isRunEventRecordSource(value.source)) {
    return null;
  }
  if (value.hostMode !== "embedded" && value.hostMode !== "daemon") {
    return null;
  }
  if (value.controllerInstanceId !== undefined && typeof value.controllerInstanceId !== "string") {
    return null;
  }
  if (!isOptionalNonNegativeInteger(value.sessionIndex)) {
    return null;
  }
  if (!isOptionalNonNegativeInteger(value.attemptNumber)) {
    return null;
  }
  return value as PersistedRunEventV2;
}

function toRunAuditEnvelope(record: PersistedRunEventV2): RunAuditEnvelope {
  const fields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    if (!RUN_EVENT_SHARED_KEYS.has(key)) {
      fields[key] = value;
    }
  }
  return {
    runId: record.runId,
    cursor: record.cursor,
    event: {
      type: record.eventType,
      recordedAt: record.recordedAt,
      source: record.source,
      hostMode: record.hostMode,
      ...(record.controllerInstanceId !== undefined
        ? { controllerInstanceId: record.controllerInstanceId }
        : {}),
      ...(record.sessionIndex !== undefined ? { sessionIndex: record.sessionIndex } : {}),
      ...(record.attemptNumber !== undefined ? { attemptNumber: record.attemptNumber } : {}),
      fields,
    },
  };
}

function readRunAuditHistoryInternal(params: {
  workspaceDir: string;
  runId: string;
  limit?: number;
}): ReadRunAuditHistoryResult {
  const auditPath = runEventsPath(params.workspaceDir);
  if (!existsSync(auditPath)) {
    return {
      runId: params.runId,
      events: [],
      lastCursor: 0,
      malformedCount: 0,
    };
  }

  const raw = readFileSync(auditPath, "utf8");
  const lines = raw.length === 0 ? [] : raw.split("\n");
  if (lines.at(-1) === "") {
    lines.pop();
  }

  const events: RunAuditEnvelope[] = [];
  let lastCursor = 0;
  let malformedCount = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedCount += 1;
      continue;
    }

    const record = parsePersistedRunEventV2(parsed);
    if (!record) {
      malformedCount += 1;
      continue;
    }
    if (record.runId !== params.runId) {
      continue;
    }
    events.push(toRunAuditEnvelope(record));
    lastCursor = record.cursor;
  }

  return {
    runId: params.runId,
    events:
      params.limit === undefined ? events : events.slice(Math.max(0, events.length - params.limit)),
    lastCursor,
    malformedCount,
  };
}

export function readRunAuditHistory(params: {
  workspaceDir: string;
  runId: string;
  limit?: number;
}): RunAuditHistory {
  return readRunAuditHistoryInternal(params);
}

function appendRunEvent(params: {
  workspaceDir: string;
  runId: string;
  eventType: RunEventType;
  context: RunEventWriteContext;
  sessionIndex?: number;
  attemptNumber?: number;
  fields?: Record<string, unknown>;
}): RunAuditEnvelope {
  const cursor =
    readRunAuditHistoryInternal({
      workspaceDir: params.workspaceDir,
      runId: params.runId,
    }).lastCursor + 1;
  const record: PersistedRunEventV2 & Record<string, unknown> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    cursor,
    runId: params.runId,
    eventType: params.eventType,
    source: params.context.source,
    hostMode: params.context.hostMode,
    ...(params.context.controllerInstanceId !== undefined
      ? { controllerInstanceId: params.context.controllerInstanceId }
      : {}),
    ...(params.sessionIndex !== undefined ? { sessionIndex: params.sessionIndex } : {}),
    ...(params.attemptNumber !== undefined ? { attemptNumber: params.attemptNumber } : {}),
    ...(params.fields ?? {}),
  };
  appendTextFileDurable(runEventsPath(params.workspaceDir), `${JSON.stringify(record)}\n`);
  return toRunAuditEnvelope(record);
}

export function appendRunCreatedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId" | "backend" | "cwd" | "name" | "status">;
  context: RunEventWriteContext;
  agentName: string;
  assignmentName: string | null;
  passive: boolean;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.created",
    context: params.context,
    fields: {
      backend: params.manifest.backend,
      agentName: params.agentName,
      assignmentName: params.assignmentName,
      cwd: params.manifest.cwd,
      passive: params.passive,
      initialStatus: params.manifest.status,
      name: params.manifest.name,
    },
  });
}

export function appendRunStartedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId" | "backend" | "cwd" | "name">;
  context: RunEventWriteContext;
  sessionIndex: number;
  backendSessionIdAtStart: string | null;
  resumed: boolean;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: params.resumed ? "run.resumed" : "run.started",
    context: params.context,
    sessionIndex: params.sessionIndex,
    fields: {
      backend: params.manifest.backend,
      name: params.manifest.name,
      cwd: params.manifest.cwd,
      backendSessionIdAtStart: params.backendSessionIdAtStart,
    },
  });
}

export function appendRunBackendSessionUpdatedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  previousBackendSessionId: string | null;
  nextBackendSessionId: string | null;
  reason: BackendSessionUpdateReason;
  sessionIndex?: number;
  attemptNumber?: number;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.backend_session_updated",
    context: params.context,
    sessionIndex: params.sessionIndex,
    attemptNumber: params.attemptNumber,
    fields: {
      previousBackendSessionId: params.previousBackendSessionId,
      nextBackendSessionId: params.nextBackendSessionId,
      reason: params.reason,
    },
  });
}

export function appendRunAttemptRecordedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  sessionIndex: number;
  attemptNumber: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  backendSessionIdAtStart: string | null;
  backendSessionIdCaptured: string | null;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.attempt_recorded",
    context: params.context,
    sessionIndex: params.sessionIndex,
    attemptNumber: params.attemptNumber,
    fields: {
      exitCode: params.exitCode,
      signal: params.signal,
      timedOut: params.timedOut,
      backendSessionIdAtStart: params.backendSessionIdAtStart,
      backendSessionIdCaptured: params.backendSessionIdCaptured,
    },
  });
}

export function appendRunHookRecordedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  phase: string;
  hookId: string;
  outcome: string;
  startedAt: string;
  endedAt: string;
  sessionIndex?: number | null;
  attemptNumber?: number | null;
  taskId?: string | null;
  summary?: string | null;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.hook_recorded",
    context: params.context,
    ...(params.sessionIndex !== null && params.sessionIndex !== undefined
      ? { sessionIndex: params.sessionIndex }
      : {}),
    ...(params.attemptNumber !== null && params.attemptNumber !== undefined
      ? { attemptNumber: params.attemptNumber }
      : {}),
    fields: {
      phase: params.phase,
      hookId: params.hookId,
      outcome: params.outcome,
      startedAt: params.startedAt,
      endedAt: params.endedAt,
      ...(params.taskId !== null && params.taskId !== undefined ? { taskId: params.taskId } : {}),
      ...(params.summary !== null && params.summary !== undefined
        ? { summary: params.summary }
        : {}),
    },
  });
}

export function appendRunRetryingEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  sessionIndex: number;
  incompleteCount: number;
  invalidStatusCount: number;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.retrying",
    context: params.context,
    sessionIndex: params.sessionIndex,
    fields: {
      incompleteCount: params.incompleteCount,
      invalidStatusCount: params.invalidStatusCount,
    },
  });
}

export function appendRunFinishedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  terminalStatus: Extract<
    ManifestStatus,
    "ready" | "success" | "blocked" | "exhausted" | "aborted" | "error"
  >;
  exitCode: number | null;
  tasksCompleted: number;
  tasksTotal: number;
  sessionIndex?: number;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.finished",
    context: params.context,
    sessionIndex: params.sessionIndex,
    fields: {
      terminalStatus: params.terminalStatus,
      exitCode: params.exitCode,
      tasksCompleted: params.tasksCompleted,
      tasksTotal: params.tasksTotal,
    },
  });
}

export function appendRunAbortedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  sessionIndex: number;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.aborted",
    context: params.context,
    sessionIndex: params.sessionIndex,
  });
}

export function appendRunResumeRejectedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  sessionIndex: number;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.resume_rejected",
    context: params.context,
    sessionIndex: params.sessionIndex,
  });
}

export function appendRunReadyEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  previousStatus: ManifestStatus;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.ready",
    context: params.context,
    fields: {
      previousStatus: params.previousStatus,
    },
  });
}

export function appendRunResetEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  previousStatus: ManifestStatus;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.reset",
    context: params.context,
    fields: {
      previousStatus: params.previousStatus,
    },
  });
}

export function appendRunReconfiguredEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  // Audit metadata intentionally records changed keys and a boolean only,
  // never runtime var values or message text.
  changedVarKeys: string[];
  messageChanged: boolean;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.reconfigured",
    context: params.context,
    fields: {
      changedVarKeys: [...params.changedVarKeys],
      messageChanged: params.messageChanged,
    },
  });
}

export function appendRunArchivedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.archived",
    context: params.context,
  });
}

export function appendRunUnarchivedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.unarchived",
    context: params.context,
  });
}

export function appendRunRenamedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  previousName: string | null;
  nextName: string | null;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.renamed",
    context: params.context,
    fields: {
      previousName: params.previousName,
      nextName: params.nextName,
    },
  });
}

export function appendRunGroupChangedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  previousRunGroupId: string;
  nextRunGroupId: string;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.group_changed",
    context: params.context,
    fields: {
      previousRunGroupId: params.previousRunGroupId,
      nextRunGroupId: params.nextRunGroupId,
    },
  });
}

function appendRunScheduleEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  eventType: Extract<RunEventType, `run.schedule_${string}`>;
  schedule?: RunSchedule | null;
  previousSchedule?: RunSchedule | null;
  reason?: ScheduleDecisionReason;
  error?: string;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: params.eventType,
    context: params.context,
    fields: {
      ...(params.previousSchedule !== undefined
        ? { previousSchedule: params.previousSchedule }
        : {}),
      ...(params.schedule !== undefined ? { schedule: params.schedule } : {}),
      ...(params.reason !== undefined ? { reason: params.reason } : {}),
      ...(params.error !== undefined ? { error: params.error } : {}),
    },
  });
}

export function appendRunScheduleSetEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
  previousSchedule: RunSchedule | null;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_set",
  });
}

export function appendRunScheduleClearedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  previousSchedule: RunSchedule;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_cleared",
    schedule: null,
  });
}

export function appendRunScheduleEnabledEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_enabled",
  });
}

export function appendRunScheduleDisabledEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
  reason?: ScheduleDecisionReason;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_disabled",
  });
}

export function appendRunScheduleDueEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_due",
  });
}

export function appendRunScheduleMissedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
  reason: ScheduleDecisionReason;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_missed",
  });
}

export function appendRunScheduleSkippedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
  reason: ScheduleDecisionReason;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_skipped",
  });
}

export function appendRunScheduleFailedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule | null;
  reason: ScheduleDecisionReason;
  error: string;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_failed",
  });
}

export function appendRunScheduleAdvancedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
  previousSchedule: RunSchedule;
  reason?: ScheduleDecisionReason;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_advanced",
  });
}

export function appendRunScheduleConsumedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  schedule: RunSchedule;
}): RunAuditEnvelope {
  return appendRunScheduleEvent({
    ...params,
    eventType: "run.schedule_consumed",
  });
}

export function appendRunQueuedResumeMessageAddedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  messageId: string;
  messageCreatedAt: string;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.queued_resume_message_added",
    context: params.context,
    fields: {
      messageId: params.messageId,
      messageCreatedAt: params.messageCreatedAt,
    },
  });
}

export function appendRunQueuedResumeMessageRemovedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  messageId: string;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.queued_resume_message_removed",
    context: params.context,
    fields: {
      messageId: params.messageId,
    },
  });
}

export function appendRunQueuedResumeMessagesDrainedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  messageIds: string[];
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.queued_resume_messages_drained",
    context: params.context,
    fields: {
      messageIds: [...params.messageIds],
      messageCount: params.messageIds.length,
    },
  });
}

export function appendTaskAddedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  taskId: string;
  taskTitle: string;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "task.added",
    context: params.context,
    fields: {
      taskId: params.taskId,
      taskTitle: params.taskTitle,
      taskStatus: "pending",
    },
  });
}

export function appendTaskUpdatedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  taskId: string;
  taskTitle: string;
  command: "set" | "append_notes";
  statusBefore?: TaskStatus;
  statusAfter?: TaskStatus;
  notesChanged: boolean;
}): RunAuditEnvelope {
  return appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "task.updated",
    context: params.context,
    fields: {
      taskId: params.taskId,
      taskTitle: params.taskTitle,
      command: params.command,
      ...(params.statusBefore !== undefined ? { statusBefore: params.statusBefore } : {}),
      ...(params.statusAfter !== undefined ? { statusAfter: params.statusAfter } : {}),
      notesChanged: params.notesChanged,
    },
  });
}
