import { readFileSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { DefinitionEntry } from "../config/loader.js";
import { loadAgentConfig, loadAssignmentConfig } from "../config/loader.js";
import type {
  AttachmentListEntry,
  AttachmentListOptions,
  RunAttachment,
  RunAttachmentDownloadResult,
  RunAttachmentRemoveResult,
} from "../contracts/attachments.js";
import type {
  RunAuditHistory,
  RunTimelineAttempt,
  RunTimelineHistory,
} from "../contracts/events.js";
import type { RunInputSurface, RunInputSurfaceParams } from "../contracts/run-input-surface.js";
import type {
  QueueResumeMessageResult,
  RemoveQueuedResumeMessageResult,
  RunArchiveResult,
  RunBackendSessionResult,
  RunDeleteResult,
  RunDependenciesResult,
  RunDependencyRef,
  RunDetail,
  RunGroupResult,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunSummary,
  RunTaskDeleteResult,
  RunTaskSummary,
} from "../contracts/runs.js";
import { toRunDetail } from "../contracts/runs.js";
import type { ReconfigureRunPatch } from "../contracts/runs.js";
import type { WorkspaceDiff, WorkspaceDiffInput } from "../contracts/workspace-diffs.js";
import type {
  WorkspaceFileContent,
  WorkspaceFileDirectory,
  WorkspaceFileSearch,
} from "../contracts/workspace-files.js";
import type { BackendName } from "../core/backends/types.js";
import {
  type RunListFilter,
  addAttachmentFromFile,
  addAttachmentFromStream,
  addRunDependency,
  addTask,
  appendTaskNotes,
  archiveRun,
  cleanupRunEnvironment as cleanupRunEnvironmentCommand,
  clearRunBackendSession,
  clearRunDependencies,
  clearRunGroup,
  clearRunSchedule as clearRunScheduleCommand,
  deleteRun,
  deleteTask,
  downloadAttachment,
  drainQueuedResumeMessages as drainQueuedResumeMessagesCommand,
  listAttachments,
  listDefinitions,
  listRuns,
  listTasks,
  readyRun as markRunReady,
  queueResumeMessage as queueResumeMessageCommand,
  readAttachment,
  readBrief,
  readRunEnvironment,
  readRunSummary,
  readStatus,
  removeAttachment,
  removeQueuedResumeMessage as removeQueuedResumeMessageCommand,
  removeRunDependency,
  resetRun,
  setRunBackendSession,
  setRunGroup,
  setRunName,
  setRunNote,
  setRunPinned,
  setRunSchedule as setRunScheduleCommand,
  setRunScheduleEnabled as setRunScheduleEnabledCommand,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
  validateRunEnvironment as validateRunEnvironmentCommand,
} from "../core/commands/service.js";
import type { LoadedEnvironmentDefinition } from "../core/config/environments.js";
import type { LoadedLauncherDefinition } from "../core/config/launchers.js";
import type {
  AgentConfig,
  AssignmentConfig,
  EnvironmentDefinitionConfig,
  TaskDef,
} from "../core/config/schema.js";
import type { AttemptLog, AttemptRecord } from "../core/run/manifest.js";
import { type RunExecution, resolveResumeTarget } from "../core/run/manifest.js";
import { reconfigureInitializedRun } from "../core/run/reconfigure.js";
import type { RunEventOrigin } from "../core/run/run-events.js";
import type { RunAuditEnvelope } from "../core/run/run-events.js";
import { readRunAuditHistory } from "../core/run/run-events.js";
import type { RunEvent, RunOutcome } from "../core/run/run-loop.js";
import type { ScheduleInput } from "../core/run/schedule.js";
import { resolveStaticInputSurface } from "../core/run/static-input-surface.js";
import { getWorkspaceDiffForRun } from "../core/run/workspace-diffs.js";
import {
  listWorkspaceFiles,
  readWorkspaceFile,
  searchWorkspaceFiles,
} from "../core/run/workspace-files.js";
import { executeRunCommand } from "../run-command.js";
import { startDebugPerfTimer } from "../util/debug-perf.js";

export type DefinitionDetail =
  | {
      kind: "agent";
      config: AgentConfig;
      instructions: string;
      sourcePath: string | null;
    }
  | {
      kind: "assignment";
      config: AssignmentConfig;
      instructions: string;
      sourcePath: string;
    }
  | {
      kind: "launcher";
      definition: LoadedLauncherDefinition;
    }
  | {
      kind: "environment";
      definition: LoadedEnvironmentDefinition;
      config: EnvironmentDefinitionConfig;
    }
  | {
      kind: "task";
      task: TaskDef;
      sourcePath: string;
    };

export interface RunCommandOverrides {
  cwd?: string;
  backend?: BackendName;
  launcher?: string;
  executionEnvironment?: string;
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  backendConfig?: Partial<Record<BackendName, unknown>>;
  message?: string;
  name?: string;
  timeoutSec?: number;
  unrestricted?: boolean;
  maxRetries?: number;
  addedTasks?: string[];
  schedule?: ScheduleInput;
}

export interface StartRunRequest {
  runId?: string;
  agent?: string;
  assignment?: string;
  definitionCwd?: string;
  callerCwd?: string;
  parentRunId?: string | null;
  runGroupId?: string | null;
  backendSessionId?: string;
  cliVars: Record<string, string>;
  webVars: Record<string, string>;
  overrides: RunCommandOverrides;
  execution?: RunExecution;
  abortSignal?: AbortSignal;
  detachSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
  emitAuditEnvelope?: (envelope: RunAuditEnvelope) => void;
}

export interface ResumeRunRequest {
  target: string;
  parentRunId?: string | null;
  overrides: RunCommandOverrides;
  execution?: RunExecution;
  abortSignal?: AbortSignal;
  detachSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
  emitAuditEnvelope?: (envelope: RunAuditEnvelope) => void;
}

// Optional host/controller provenance for mutation calls that should be
// reflected in per-run diagnostic audit records.
export interface MutationAuditContext extends RunEventOrigin {}

type AuditEnvelopeEmitter = (envelope: RunAuditEnvelope) => void;

function toDefinitionDetail(result: ReturnType<typeof showDefinition>): DefinitionDetail {
  if (result.kind === "task") {
    return {
      kind: "task",
      task: result.loaded.task,
      sourcePath: result.loaded.sourcePath,
    };
  }
  if (result.kind === "launcher") {
    return {
      kind: "launcher",
      definition: result.loaded,
    };
  }
  if (result.kind === "environment") {
    return {
      kind: "environment",
      definition: result.loaded,
      config: result.loaded.config,
    };
  }
  if (result.kind === "agent") {
    return {
      kind: "agent",
      config: result.loaded.config,
      instructions: result.loaded.instructions,
      sourcePath: result.loaded.sourcePath,
    };
  }
  return {
    kind: "assignment",
    config: result.loaded.config,
    instructions: result.loaded.instructions,
    sourcePath: result.loaded.sourcePath,
  };
}

function readAttemptLogForRecord(
  runId: string,
  workspaceDir: string,
  record: AttemptRecord,
): AttemptLog {
  const finish = startDebugPerfTimer("runs.read_attempt_log", {
    runId,
    attemptNumber: record.attemptNumber,
    sessionIndex: record.sessionIndex,
    attemptIndexInSession: record.attemptIndexInSession,
    logPath: record.logPath,
  });
  try {
    const workspaceRoot = resolve(workspaceDir);
    const absoluteLogPath = resolve(workspaceRoot, record.logPath);
    if (
      absoluteLogPath !== workspaceRoot &&
      !absoluteLogPath.startsWith(`${workspaceRoot}${sep}`)
    ) {
      throw new Error("attempt log path escapes workspace");
    }
    const raw = readFileSync(absoluteLogPath, "utf8");
    const parsed = JSON.parse(raw) as AttemptLog;
    if (
      parsed.schemaVersion !== 3 ||
      parsed.runId !== runId ||
      parsed.attemptNumber !== record.attemptNumber ||
      parsed.sessionIndex !== record.sessionIndex ||
      parsed.attemptIndexInSession !== record.attemptIndexInSession
    ) {
      throw new Error(
        `attempt log ${record.logPath} does not match schemaVersion 3 record identity`,
      );
    }
    finish({
      fallback: false,
      stderrBytes: parsed.stderr.length,
    });
    return parsed;
  } catch {
    const fallback: AttemptLog = {
      schemaVersion: 3,
      runId,
      attemptNumber: record.attemptNumber,
      sessionIndex: record.sessionIndex,
      attemptIndexInSession: record.attemptIndexInSession,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      stderr: "",
    };
    finish({
      fallback: true,
      stderrBytes: 0,
    });
    return fallback;
  }
}

function toRunTimelineAttempt(
  runId: string,
  workspaceDir: string,
  record: AttemptRecord,
): RunTimelineAttempt {
  const log = readAttemptLogForRecord(runId, workspaceDir, record);
  return {
    attemptNumber: record.attemptNumber,
    sessionIndex: record.sessionIndex,
    attemptIndexInSession: record.attemptIndexInSession,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    prompt: record.prompt,
    transcript: record.transcript ?? "",
    notices: log.stderr,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    live: false,
    provenance:
      record.provenance.kind === "backend_session"
        ? { kind: "backend_session", mode: record.provenance.mode }
        : { kind: "task_runner" },
  };
}

export function getRun(target: string): RunDetail {
  return readStatus(target);
}

export function getRunSummary(target: string): RunSummary {
  return readRunSummary(target);
}

export function getRunTimelineHistory(target: string): RunTimelineHistory {
  const finish = startDebugPerfTimer("runs.timeline_history", { target });
  const detail = getRun(target);
  const resolved = resolveResumeTarget(detail.workspaceDir);
  const history = {
    runId: resolved.manifest.runId,
    attempts: resolved.manifest.attemptRecords.map((record) =>
      toRunTimelineAttempt(resolved.manifest.runId, resolved.workspaceDir, record),
    ),
    lastCursor: 0,
  };
  finish({
    runId: history.runId,
    attemptCount: history.attempts.length,
  });
  return history;
}

export function getRunAuditHistory(
  target: string,
  opts: {
    limit?: number;
  } = {},
): RunAuditHistory {
  const finish = startDebugPerfTimer("runs.audit_history", {
    target,
    limit: opts.limit ?? null,
  });
  const detail = getRun(target);
  const resolved = resolveResumeTarget(detail.workspaceDir);
  const history = readRunAuditHistory({
    workspaceDir: resolved.workspaceDir,
    runId: resolved.manifest.runId,
    limit: opts.limit,
  });
  finish({
    runId: history.runId,
    eventCount: history.events.length,
    lastCursor: history.lastCursor,
  });
  return history;
}

export function getRunBrief(target: string): string {
  return readBrief(target);
}

export function getRunEnvironment(target: string): ReturnType<typeof readRunEnvironment> {
  return readRunEnvironment(target);
}

export function validateRunEnvironment(
  target: string,
): Promise<Awaited<ReturnType<typeof validateRunEnvironmentCommand>>> {
  return validateRunEnvironmentCommand(target);
}

export function cleanupRunEnvironment(
  target: string,
): Promise<Awaited<ReturnType<typeof cleanupRunEnvironmentCommand>>> {
  return cleanupRunEnvironmentCommand(target);
}

export function getRunList(filter: RunListFilter = {}): RunSummary[] {
  return listRuns(filter);
}

export function queueResumeMessage(
  input: { target: string; message: string },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): QueueResumeMessageResult {
  return queueResumeMessageCommand(input, auditContext, emitAuditEnvelope);
}

export function removeQueuedResumeMessage(
  input: { target: string; messageId: string },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RemoveQueuedResumeMessageResult {
  return removeQueuedResumeMessageCommand(input, auditContext, emitAuditEnvelope);
}

export function drainQueuedResumeMessages(
  input: { target: string; messageIds: string[] },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): {
  run: RunDetail;
  removedMessageIds: string[];
} {
  return drainQueuedResumeMessagesCommand(input, auditContext, emitAuditEnvelope);
}

export function getTaskList(target: string): RunTaskSummary[] {
  return listTasks(target).tasks.map((task) => ({
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    notes: task.notes,
  }));
}

export function getTask(target: string, taskId: string): RunTaskSummary {
  const { task } = showTask(target, taskId);
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    notes: task.notes,
  };
}

export function getAttachmentList(
  target: string,
  options: AttachmentListOptions = {},
): AttachmentListEntry[] {
  return listAttachments(target, options).attachments;
}

export function getAttachment(
  target: string,
  attachmentId: string,
): {
  attachment: RunAttachment;
  absolutePath: string;
} {
  const result = readAttachment(target, attachmentId);
  return {
    attachment: result.attachment,
    absolutePath: result.absolutePath,
  };
}

export function getWorkspaceFileList(
  target: string,
  input: { path?: string } = {},
): WorkspaceFileDirectory {
  const { manifest } = resolveResumeTarget(target);
  return listWorkspaceFiles(manifest, input);
}

export function getWorkspaceFileSearch(
  target: string,
  input: { query: string; limit?: number },
): Promise<WorkspaceFileSearch> {
  const { manifest } = resolveResumeTarget(target);
  return searchWorkspaceFiles(manifest, input);
}

export function getWorkspaceFile(target: string, input: { path: string }): WorkspaceFileContent {
  const { manifest } = resolveResumeTarget(target);
  return readWorkspaceFile(manifest, input);
}

export function getWorkspaceDiff(
  target: string,
  input: WorkspaceDiffInput,
): Promise<WorkspaceDiff> {
  const { manifest } = resolveResumeTarget(target);
  return getWorkspaceDiffForRun(manifest, input);
}

export function getDefinitionList(
  kind: "agent" | "assignment" | "launcher" | "task" | "environment",
): ReturnType<typeof listDefinitions> {
  return listDefinitions(kind);
}

export function getDefinition(
  kind: "agent" | "assignment" | "launcher" | "task" | "environment",
  target: string,
  cwd?: string,
): DefinitionDetail {
  return toDefinitionDetail(showDefinition(kind, target, cwd));
}

export function getRunInputSurface(params: RunInputSurfaceParams): RunInputSurface {
  return resolveStaticInputSurface(
    loadAgentConfig(params.agent, params.cwd),
    loadAssignmentConfig(params.assignment, params.cwd),
  );
}

export function archive(
  target: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunArchiveResult {
  return archiveRun(target, auditContext, emitAuditEnvelope);
}

export function unarchive(
  target: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunArchiveResult {
  return unarchiveRun(target, auditContext, emitAuditEnvelope);
}

export async function reset(
  target: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunDetail> {
  const result = await resetRun(target, auditContext, emitAuditEnvelope);
  return toRunDetail({
    manifest: result.manifest,
    isLive: false,
  });
}

export function readyRun(
  target: string,
  input: { schedule?: ScheduleInput } = {},
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunDetail {
  return markRunReady(target, input.schedule, auditContext, emitAuditEnvelope);
}

export function setRunSchedule(
  target: string,
  input: { schedule: ScheduleInput },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunDetail {
  return setRunScheduleCommand(target, input.schedule, auditContext, emitAuditEnvelope);
}

export function clearRunSchedule(
  target: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunDetail {
  return clearRunScheduleCommand(target, auditContext, emitAuditEnvelope);
}

export function setRunScheduleEnabled(
  target: string,
  input: { enabled: boolean },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunDetail {
  return setRunScheduleEnabledCommand(target, input.enabled, auditContext, emitAuditEnvelope);
}

export function deleteArchivedRun(
  target: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunDeleteResult> {
  return deleteRun(target, auditContext, emitAuditEnvelope);
}

export function renameRun(
  target: string,
  input: { name: string | null },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunNameResult> {
  return setRunName(target, input, auditContext, emitAuditEnvelope);
}

export function updateRunNote(target: string, input: { note: string | null }): RunNoteResult {
  return setRunNote(target, input);
}

export function updateRunPinned(target: string, input: { pinned: boolean }): RunPinnedResult {
  return setRunPinned(target, input);
}

export function updateRunBackendSession(
  target: string,
  input: { backendSessionId: string },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunBackendSessionResult {
  return setRunBackendSession(target, input, auditContext, emitAuditEnvelope);
}

export function clearBackendSession(
  target: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunBackendSessionResult {
  return clearRunBackendSession(target, auditContext, emitAuditEnvelope);
}

export function setGroup(
  target: string,
  input: { runGroupId: string },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunGroupResult {
  return setRunGroup(target, input, auditContext, emitAuditEnvelope);
}

export function clearGroup(
  target: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): RunGroupResult {
  return clearRunGroup(target, auditContext, emitAuditEnvelope);
}

export function addDependency(target: string, dependency: RunDependencyRef): RunDependenciesResult {
  return addRunDependency(target, dependency);
}

export function removeDependency(
  target: string,
  dependency: RunDependencyRef,
): RunDependenciesResult {
  return removeRunDependency(target, dependency);
}

export function clearDependencies(target: string): RunDependenciesResult {
  return clearRunDependencies(target);
}

export function reconfigureRun(
  target: string,
  patch: ReconfigureRunPatch,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunDetail> {
  return reconfigureInitializedRun(target, patch, auditContext, emitAuditEnvelope);
}

export function removeRunAttachment(
  target: string,
  attachmentId: string,
): RunAttachmentRemoveResult {
  return removeAttachment(target, attachmentId);
}

export function downloadRunAttachment(
  target: string,
  attachmentId: string,
  outputPath: string,
): RunAttachmentDownloadResult {
  return downloadAttachment(target, attachmentId, outputPath);
}

export function addRunAttachmentFromFile(
  target: string,
  input: { sourcePath: string; name?: string; mimeType?: string },
): Promise<RunAttachment> {
  return addAttachmentFromFile(target, input).then((result) => result.attachment);
}

export function addRunAttachmentFromStream(
  target: string,
  input: {
    name: string;
    source: AsyncIterable<Uint8Array>;
    commitSignal: Promise<void>;
    mimeType?: string;
  },
): Promise<RunAttachment> {
  return addAttachmentFromStream(target, input).then((result) => result.attachment);
}

export function updateTask(
  target: string,
  taskId: string,
  update: { status?: string; notes?: string; title?: string; body?: string },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunTaskSummary> {
  return setTask(target, taskId, update, auditContext, emitAuditEnvelope).then((result) =>
    getTaskFromMutation(result.task),
  );
}

export function appendNotes(
  target: string,
  taskId: string,
  text: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunTaskSummary> {
  return appendTaskNotes(target, taskId, text, auditContext, emitAuditEnvelope).then((result) =>
    getTaskFromMutation(result.task),
  );
}

export function createTask(
  target: string,
  input: { title: string; body?: string },
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunTaskSummary> {
  return addTask(target, input, auditContext, emitAuditEnvelope).then((result) =>
    getTaskFromMutation(result.task),
  );
}

export function removeTask(
  target: string,
  taskId: string,
  auditContext?: MutationAuditContext,
  emitAuditEnvelope?: AuditEnvelopeEmitter,
): Promise<RunTaskDeleteResult> {
  return deleteTask(target, taskId, auditContext, emitAuditEnvelope);
}

function getTaskFromMutation(task: ReturnType<typeof showTask>["task"]): RunTaskSummary {
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    notes: task.notes,
  };
}

export async function initRun(request: StartRunRequest): Promise<RunDetail> {
  const outcome = await executeRunCommand({
    initialize: true,
    resumeRun: request.runId,
    agent: request.agent,
    assignment: request.assignment,
    definitionCwd: request.definitionCwd,
    callerCwd: request.callerCwd,
    parentRunId: request.parentRunId,
    runGroupId: request.runGroupId,
    backendSessionId: request.backendSessionId,
    cliVars: request.cliVars,
    webVars: request.webVars,
    overrides: request.overrides,
    execution: request.execution,
    abortSignal: request.abortSignal,
    detachSignal: request.detachSignal,
    emitEvent: request.emitEvent,
    emitAuditEnvelope: request.emitAuditEnvelope,
  });
  return toRunDetail({ manifest: outcome.manifest, isLive: false });
}

export function startRun(request: StartRunRequest): Promise<RunOutcome> {
  return executeRunCommand({
    initialize: false,
    agent: request.agent,
    assignment: request.assignment,
    definitionCwd: request.definitionCwd,
    callerCwd: request.callerCwd,
    parentRunId: request.parentRunId,
    runGroupId: request.runGroupId,
    backendSessionId: request.backendSessionId,
    cliVars: request.cliVars,
    webVars: request.webVars,
    overrides: request.overrides,
    execution: request.execution,
    abortSignal: request.abortSignal,
    detachSignal: request.detachSignal,
    emitEvent: request.emitEvent,
    emitAuditEnvelope: request.emitAuditEnvelope,
  });
}

export function resumeRun(request: ResumeRunRequest): Promise<RunOutcome> {
  return executeRunCommand({
    initialize: false,
    resumeRun: request.target,
    cliVars: {},
    webVars: {},
    parentRunId: request.parentRunId,
    overrides: request.overrides,
    execution: request.execution,
    abortSignal: request.abortSignal,
    detachSignal: request.detachSignal,
    emitEvent: request.emitEvent,
    emitAuditEnvelope: request.emitAuditEnvelope,
  });
}
