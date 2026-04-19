import { join } from "node:path";
import type { TaskStatus } from "../../assignment/model.js";
import { appendTextFileDurable } from "../../util/write-file-atomic.js";
import type {
  ManifestStatus,
  RunExecution,
  RunExecutionHostMode,
  RunManifest,
} from "./manifest.js";

export const RUN_EVENTS_FILENAME = "run-events.jsonl";
const RUN_EVENT_SCHEMA_VERSION = 1;

export type RunEventRecordSource = "system" | "cli" | "daemon" | "task_command";

export type RunEventType =
  | "run.created"
  | "run.started"
  | "run.resumed"
  | "run.backend_session_updated"
  | "run.attempt_recorded"
  | "run.retrying"
  | "run.finished"
  | "run.aborted"
  | "run.resume_rejected"
  | "run.reset"
  | "run.archived"
  | "run.unarchived"
  | "run.renamed"
  | "task.added"
  | "task.updated";

export type BackendSessionUpdateReason =
  | "bootstrap_import"
  | "backend_capture"
  | "passive_set"
  | "passive_clear"
  | "reset_clear";

export interface RunEventOrigin {
  hostMode: RunExecutionHostMode;
  controllerInstanceId?: string;
}

export interface RunEventWriteContext extends RunEventOrigin {
  source: RunEventRecordSource;
}

interface RunEventBaseRecord {
  schemaVersion: 1;
  recordedAt: string;
  runId: string;
  eventType: RunEventType;
  source: RunEventRecordSource;
  hostMode: RunExecutionHostMode;
  controllerInstanceId?: string;
  sessionIndex?: number;
  attempt?: number;
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

function appendRunEvent(params: {
  workspaceDir: string;
  runId: string;
  eventType: RunEventType;
  context: RunEventWriteContext;
  sessionIndex?: number;
  attempt?: number;
  fields?: Record<string, unknown>;
}): void {
  const record: RunEventBaseRecord & Record<string, unknown> = {
    schemaVersion: RUN_EVENT_SCHEMA_VERSION,
    recordedAt: new Date().toISOString(),
    runId: params.runId,
    eventType: params.eventType,
    source: params.context.source,
    hostMode: params.context.hostMode,
    ...(params.context.controllerInstanceId !== undefined
      ? { controllerInstanceId: params.context.controllerInstanceId }
      : {}),
    ...(params.sessionIndex !== undefined ? { sessionIndex: params.sessionIndex } : {}),
    ...(params.attempt !== undefined ? { attempt: params.attempt } : {}),
    ...(params.fields ?? {}),
  };
  appendTextFileDurable(runEventsPath(params.workspaceDir), `${JSON.stringify(record)}\n`);
}

export function appendRunCreatedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId" | "backend" | "cwd" | "name" | "status">;
  context: RunEventWriteContext;
  agentName: string;
  assignmentName: string | null;
  passive: boolean;
}): void {
  appendRunEvent({
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
}): void {
  appendRunEvent({
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
  attempt?: number;
}): void {
  appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.backend_session_updated",
    context: params.context,
    sessionIndex: params.sessionIndex,
    attempt: params.attempt,
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
  attempt: number;
  exitCode: number | null;
  signal: string | null;
  timedOut: boolean;
  backendSessionIdAtStart: string | null;
  backendSessionIdCaptured: string | null;
}): void {
  appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.attempt_recorded",
    context: params.context,
    sessionIndex: params.sessionIndex,
    attempt: params.attempt,
    fields: {
      exitCode: params.exitCode,
      signal: params.signal,
      timedOut: params.timedOut,
      backendSessionIdAtStart: params.backendSessionIdAtStart,
      backendSessionIdCaptured: params.backendSessionIdCaptured,
    },
  });
}

export function appendRunRetryingEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  sessionIndex: number;
  incompleteCount: number;
  invalidStatusCount: number;
}): void {
  appendRunEvent({
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
    "success" | "blocked" | "exhausted" | "aborted" | "error"
  >;
  exitCode: number | null;
  tasksCompleted: number;
  tasksTotal: number;
  sessionIndex?: number;
}): void {
  appendRunEvent({
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
}): void {
  appendRunEvent({
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
}): void {
  appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.resume_rejected",
    context: params.context,
    sessionIndex: params.sessionIndex,
  });
}

export function appendRunResetEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  previousStatus: ManifestStatus;
}): void {
  appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.reset",
    context: params.context,
    fields: {
      previousStatus: params.previousStatus,
    },
  });
}

export function appendRunArchivedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
}): void {
  appendRunEvent({
    workspaceDir: params.manifest.workspaceDir,
    runId: params.manifest.runId,
    eventType: "run.archived",
    context: params.context,
  });
}

export function appendRunUnarchivedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
}): void {
  appendRunEvent({
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
}): void {
  appendRunEvent({
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

export function appendTaskAddedEvent(params: {
  manifest: Pick<RunManifest, "workspaceDir" | "runId">;
  context: RunEventWriteContext;
  taskId: string;
  taskTitle: string;
}): void {
  appendRunEvent({
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
}): void {
  appendRunEvent({
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
