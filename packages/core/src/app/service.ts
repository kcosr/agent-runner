import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { DefinitionEntry } from "../config/loader.js";
import type {
  RunAttachment,
  RunAttachmentDownloadResult,
  RunAttachmentRemoveResult,
} from "../contracts/attachments.js";
import type { RunTimelineAttempt, RunTimelineHistory } from "../contracts/events.js";
import type {
  RunArchiveResult,
  RunDependenciesResult,
  RunDetail,
  RunNameResult,
  RunSummary,
  RunTaskSummary,
} from "../contracts/runs.js";
import { toRunDetail } from "../contracts/runs.js";
import type { BackendId } from "../core/backends/types.js";
import {
  addAttachmentFromFile,
  addAttachmentFromStream,
  addRunDependency,
  addTask,
  appendTaskNotes,
  archiveRun,
  clearRunDependencies,
  downloadAttachment,
  listAttachments,
  listDefinitions,
  listRuns,
  listTasks,
  readAttachment,
  readBrief,
  readStatus,
  removeAttachment,
  removeRunDependency,
  resetRun,
  setRunName,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
} from "../core/commands/service.js";
import type { AgentConfig, AssignmentConfig } from "../core/config/schema.js";
import type { AttemptLog, AttemptRecord } from "../core/run/manifest.js";
import { type RunExecution, resolveResumeTarget } from "../core/run/manifest.js";
import type { RunEvent, RunOutcome } from "../core/run/run-loop.js";
import { executeRunCommand } from "../run-command.js";

export interface DefinitionDetail {
  kind: "agent" | "assignment";
  config: AgentConfig | AssignmentConfig;
  instructions: string;
  sourcePath: string | null;
}

export interface RunCommandOverrides {
  cwd?: string;
  backend?: BackendId;
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
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

function toDefinitionDetail(result: ReturnType<typeof showDefinition>): DefinitionDetail {
  return {
    kind: result.kind,
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
    const raw = readFileSync(join(workspaceDir, record.logPath), "utf8");
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

export function getRunTimelineHistory(target: string): RunTimelineHistory {
  const resolved = resolveResumeTarget(target);
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

export function getRunList(opts: { includeArchived?: boolean } = {}): RunSummary[] {
  return listRuns(opts);
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

export function getAttachmentList(target: string): RunAttachment[] {
  return listAttachments(target).attachments;
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

export function getDefinitionList(kind: "agent" | "assignment"): DefinitionEntry[] {
  return listDefinitions(kind).entries;
}

export function getDefinition(
  kind: "agent" | "assignment",
  target: string,
  cwd?: string,
): DefinitionDetail {
  return toDefinitionDetail(showDefinition(kind, target, cwd));
}

export function archive(target: string): RunArchiveResult {
  return archiveRun(target);
}

export function unarchive(target: string): RunArchiveResult {
  return unarchiveRun(target);
}

export function reset(target: string): RunDetail {
  return toRunDetail({ manifest: resetRun(target).manifest, isLive: false });
}

export function renameRun(target: string, input: { name: string | null }): Promise<RunNameResult> {
  return setRunName(target, input);
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
): RunTaskSummary {
  return getTaskFromMutation(setTask(target, taskId, update).task);
}

export function appendNotes(target: string, taskId: string, text: string): RunTaskSummary {
  return getTaskFromMutation(appendTaskNotes(target, taskId, text).task);
}

export function createTask(
  target: string,
  input: { title: string; body?: string },
): RunTaskSummary {
  return getTaskFromMutation(addTask(target, input).task);
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
