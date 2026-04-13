import type { DefinitionEntry } from "../config/loader.js";
import type { RunArchiveResult, RunDetail, RunSummary, RunTaskSummary } from "../contracts/runs.js";
import { toRunDetail } from "../contracts/runs.js";
import {
  addTask,
  appendTaskNotes,
  archiveRun,
  listDefinitions,
  listRuns,
  listTasks,
  readStatus,
  resetRun,
  setTask,
  showDefinition,
  showTask,
  unarchiveRun,
} from "../core/commands/service.js";
import type { AgentConfig, AssignmentConfig, TaskMode } from "../core/config/schema.js";
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
  backend?: "claude" | "codex" | "passive";
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  taskMode?: TaskMode;
  message?: string;
  sessionName?: string;
  timeoutSec?: number;
  unrestricted?: boolean;
  maxRetries?: number;
  addedTasks?: string[];
}

export interface StartRunRequest {
  agent?: string;
  assignment?: string;
  definitionCwd?: string;
  baseDir?: string;
  backendSessionId?: string;
  cliVars: Record<string, string>;
  overrides: RunCommandOverrides;
  abortSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
}

export interface ResumeRunRequest {
  target: string;
  overrides: RunCommandOverrides;
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

export function getRun(target: string): RunDetail {
  return readStatus(target);
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
    baseDir: request.baseDir,
    backendSessionId: request.backendSessionId,
    cliVars: request.cliVars,
    overrides: request.overrides,
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
    baseDir: request.baseDir,
    backendSessionId: request.backendSessionId,
    cliVars: request.cliVars,
    overrides: request.overrides,
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
    abortSignal: request.abortSignal,
    emitEvent: request.emitEvent,
  });
}
