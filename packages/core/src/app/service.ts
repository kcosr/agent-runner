import { readFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import type { DefinitionEntry } from "../config/loader.js";
import type {
  AttachmentListEntry,
  AttachmentListOptions,
  RunAttachment,
  RunAttachmentDownloadResult,
  RunAttachmentRemoveResult,
} from "../contracts/attachments.js";
import type { RunTimelineAttempt, RunTimelineHistory } from "../contracts/events.js";
import type {
  RunArchiveResult,
  RunBackendSessionResult,
  RunDeleteResult,
  RunDependenciesResult,
  RunDetail,
  RunNameResult,
  RunNoteResult,
  RunPinnedResult,
  RunSummary,
  RunTaskSummary,
} from "../contracts/runs.js";
import { toRunDetail } from "../contracts/runs.js";
import type { BackendId, BackendSpecificConfig } from "../core/backends/types.js";
import {
  type RunListFilter,
  addAttachmentFromFile,
  addAttachmentFromStream,
  addRunDependency,
  addTask,
  appendTaskNotes,
  archiveRun,
  clearRunBackendSession,
  clearRunDependencies,
  deleteRun,
  downloadAttachment,
  listAttachments,
  listDefinitions,
  listRuns,
  listTasks,
  readAttachment,
  readBrief,
  readRunSummary,
  readStatus,
  removeAttachment,
  removeRunDependency,
  resetRun,
  setRunBackendSession,
  setRunName,
  setRunNote,
  setRunPinned,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
} from "../core/commands/service.js";
import type { LoadedLauncherDefinition } from "../core/config/launchers.js";
import type { AgentConfig, AssignmentConfig } from "../core/config/schema.js";
import type { AttemptLog, AttemptRecord } from "../core/run/manifest.js";
import { type RunExecution, resolveResumeTarget } from "../core/run/manifest.js";
import type { RunEventOrigin } from "../core/run/run-events.js";
import type { RunEvent, RunOutcome } from "../core/run/run-loop.js";
import { executeRunCommand } from "../run-command.js";

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
    };

export interface RunCommandOverrides {
  cwd?: string;
  backend?: BackendId;
  launcher?: string;
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  backendSpecific?: BackendSpecificConfig;
  message?: string;
  name?: string;
  timeoutSec?: number;
  unrestricted?: boolean;
  maxRetries?: number;
  addedTasks?: string[];
}

export interface StartRunRequest {
  agent?: string;
  assignment?: string;
  definitionCwd?: string;
  callerCwd?: string;
  backendSessionId?: string;
  cliVars: Record<string, string>;
  overrides: RunCommandOverrides;
  execution?: RunExecution;
  abortSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
}

export interface ResumeRunRequest {
  target: string;
  overrides: RunCommandOverrides;
  execution?: RunExecution;
  abortSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
}

// Optional host/controller provenance for mutation calls that should be
// reflected in per-run diagnostic audit records.
export interface MutationAuditContext extends RunEventOrigin {}

function toDefinitionDetail(result: ReturnType<typeof showDefinition>): DefinitionDetail {
  if (result.kind === "launcher") {
    return {
      kind: "launcher",
      definition: result.loaded,
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
    return JSON.parse(raw) as AttemptLog;
  } catch {
    return {
      schemaVersion: 1,
      runId,
      attempt: record.attempt,
      sessionIndex: record.sessionIndex,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      stdout: "",
      stderr: "",
    };
  }
}

function toRunTimelineAttempt(
  runId: string,
  workspaceDir: string,
  record: AttemptRecord,
): RunTimelineAttempt {
  const log = readAttemptLogForRecord(runId, workspaceDir, record);
  return {
    attempt: record.attempt,
    sessionIndex: record.sessionIndex,
    startedAt: record.startedAt,
    endedAt: record.endedAt,
    prompt: record.prompt,
    transcript: record.transcript ?? "",
    notices: log.stderr,
    exitCode: record.exitCode,
    timedOut: record.timedOut,
    live: false,
  };
}

export function getRun(target: string): RunDetail {
  return readStatus(target);
}

export function getRunSummary(target: string): RunSummary {
  return readRunSummary(target);
}

export function getRunTimelineHistory(target: string): RunTimelineHistory {
  const detail = getRun(target);
  const resolved = resolveResumeTarget(detail.workspaceDir);
  return {
    runId: resolved.manifest.runId,
    attempts: resolved.manifest.attemptRecords.map((record) =>
      toRunTimelineAttempt(resolved.manifest.runId, resolved.workspaceDir, record),
    ),
    lastCursor: 0,
  };
}

export function getRunBrief(target: string): string {
  return readBrief(target);
}

export function getRunList(filter: RunListFilter = {}): RunSummary[] {
  return listRuns(filter);
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

export function getDefinitionList(
  kind: "agent" | "assignment" | "launcher",
): ReturnType<typeof listDefinitions> {
  return listDefinitions(kind);
}

export function getDefinition(
  kind: "agent" | "assignment" | "launcher",
  target: string,
  cwd?: string,
): DefinitionDetail {
  return toDefinitionDetail(showDefinition(kind, target, cwd));
}

export function archive(target: string, auditContext?: MutationAuditContext): RunArchiveResult {
  return archiveRun(target, auditContext);
}

export function unarchive(target: string, auditContext?: MutationAuditContext): RunArchiveResult {
  return unarchiveRun(target, auditContext);
}

export function reset(target: string, auditContext?: MutationAuditContext): RunDetail {
  return toRunDetail({ manifest: resetRun(target, auditContext).manifest, isLive: false });
}

export function deleteArchivedRun(target: string): RunDeleteResult {
  return deleteRun(target);
}

export function renameRun(
  target: string,
  input: { name: string | null },
  auditContext?: MutationAuditContext,
): Promise<RunNameResult> {
  return setRunName(target, input, auditContext);
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
): RunBackendSessionResult {
  return setRunBackendSession(target, input, auditContext);
}

export function clearBackendSession(
  target: string,
  auditContext?: MutationAuditContext,
): RunBackendSessionResult {
  return clearRunBackendSession(target, auditContext);
}

export function addDependency(target: string, dependencyRunId: string): RunDependenciesResult {
  return addRunDependency(target, dependencyRunId);
}

export function removeDependency(target: string, dependencyRunId: string): RunDependenciesResult {
  return removeRunDependency(target, dependencyRunId);
}

export function clearDependencies(target: string): RunDependenciesResult {
  return clearRunDependencies(target);
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
  input: { name: string; source: AsyncIterable<Uint8Array>; mimeType?: string },
): Promise<RunAttachment> {
  return addAttachmentFromStream(target, input).then((result) => result.attachment);
}

export function updateTask(
  target: string,
  taskId: string,
  update: { status?: string; notes?: string },
  auditContext?: MutationAuditContext,
): Promise<RunTaskSummary> {
  return setTask(target, taskId, update, auditContext).then((result) =>
    getTaskFromMutation(result.task),
  );
}

export function appendNotes(
  target: string,
  taskId: string,
  text: string,
  auditContext?: MutationAuditContext,
): Promise<RunTaskSummary> {
  return appendTaskNotes(target, taskId, text, auditContext).then((result) =>
    getTaskFromMutation(result.task),
  );
}

export function createTask(
  target: string,
  input: { title: string; body?: string },
  auditContext?: MutationAuditContext,
): Promise<RunTaskSummary> {
  return addTask(target, input, auditContext).then((result) => getTaskFromMutation(result.task));
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
    agent: request.agent,
    assignment: request.assignment,
    definitionCwd: request.definitionCwd,
    callerCwd: request.callerCwd,
    backendSessionId: request.backendSessionId,
    cliVars: request.cliVars,
    overrides: request.overrides,
    execution: request.execution,
    abortSignal: request.abortSignal,
    emitEvent: request.emitEvent,
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
    backendSessionId: request.backendSessionId,
    cliVars: request.cliVars,
    overrides: request.overrides,
    execution: request.execution,
    abortSignal: request.abortSignal,
    emitEvent: request.emitEvent,
  });
}

export function resumeRun(request: ResumeRunRequest): Promise<RunOutcome> {
  return executeRunCommand({
    initialize: false,
    resumeRun: request.target,
    cliVars: {},
    overrides: request.overrides,
    execution: request.execution,
    abortSignal: request.abortSignal,
    emitEvent: request.emitEvent,
  });
}
