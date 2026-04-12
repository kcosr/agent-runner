import type { StatusCommandResult } from "../commands/service.js";
import type { LockableField, TaskMode } from "../config/schema.js";
import type { TaskSnapshot } from "../runner/manifest.js";
import type { ListedRunManifest, ManifestStatus, RunManifest } from "../runner/manifest.js";

export type RunStatus = ManifestStatus;

export interface RunSummary {
  runId: string;
  repo: string;
  status: RunStatus;
  archivedAt: string | null;
  agentName: string;
  assignmentName: string | null;
  backend: string;
  model: string | null;
  sessionName: string | null;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  tasksCompleted: number;
  tasksTotal: number;
}

export interface RunTaskSummary {
  id: string;
  title: string;
  body: string;
  status: TaskSnapshot["status"];
  notes: string;
}

export interface RunCapabilities {
  canArchive: boolean;
  canUnarchive: boolean;
  canResume: boolean;
  canAbort: boolean;
  canMutateTasks: boolean;
}

export interface RunDetail {
  runId: string;
  status: RunStatus;
  archivedAt: string | null;
  isLive: boolean;
  agent: {
    name: string;
    sourcePath: string | null;
  };
  assignment: {
    name: string;
    sourcePath: string;
    workspacePath: string;
  } | null;
  backend: string;
  model: string | null;
  effort: string | null;
  sessionName: string | null;
  backendSessionId: string | null;
  cwd: string;
  taskMode: TaskMode;
  unrestricted: boolean;
  timeoutSec: number;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  attempts: number;
  maxAttempts: number;
  tasksCompleted: number;
  tasksTotal: number;
  tasks: RunTaskSummary[];
  message: string | null;
  callerInstructions: string | null;
  pendingPrompt: string | null;
  lockedFields: LockableField[];
  runtimeVars: Record<string, unknown>;
  capabilities: RunCapabilities;
}

export interface RunArchiveResult {
  runId: string;
  status: RunStatus;
  archivedAt: string | null;
  changed: boolean;
}

export interface RunActionTarget {
  target: string;
}

function resolvedTaskMode(manifest: Pick<RunManifest, "taskMode">): TaskMode {
  return manifest.taskMode ?? "file";
}

function toRunTaskSummary(task: TaskSnapshot): RunTaskSummary {
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    notes: task.notes,
  };
}

export function toRunSummary(entry: ListedRunManifest): RunSummary {
  return {
    runId: entry.manifest.runId,
    repo: entry.repo,
    status: entry.manifest.status,
    archivedAt: entry.manifest.archivedAt,
    agentName: entry.manifest.agent.name,
    assignmentName: entry.manifest.assignment?.name ?? null,
    backend: entry.manifest.backend,
    model: entry.manifest.model,
    sessionName: entry.manifest.sessionName,
    cwd: entry.manifest.cwd,
    startedAt: entry.manifest.startedAt,
    endedAt: entry.manifest.endedAt,
    tasksCompleted: entry.manifest.tasksCompleted,
    tasksTotal: entry.manifest.tasksTotal,
  };
}

export function deriveRunCapabilities(manifest: RunManifest): RunCapabilities {
  const isRunning = manifest.status === "running";
  const isArchived = manifest.archivedAt !== null;
  const isCliModeRun = resolvedTaskMode(manifest) === "cli";

  return {
    canArchive: !isRunning && !isArchived,
    canUnarchive: !isRunning && isArchived,
    canResume: !isRunning && !isArchived && manifest.backend !== "passive",
    canAbort: false,
    canMutateTasks: !isRunning || isCliModeRun,
  };
}

export function toRunDetail(result: StatusCommandResult): RunDetail {
  const { manifest } = result;
  return {
    runId: manifest.runId,
    status: manifest.status,
    archivedAt: manifest.archivedAt,
    isLive: result.isLive,
    agent: {
      name: manifest.agent.name,
      sourcePath: manifest.agent.sourcePath,
    },
    assignment: manifest.assignment
      ? {
          name: manifest.assignment.name,
          sourcePath: manifest.assignment.sourcePath,
          workspacePath: manifest.assignment.workspacePath,
        }
      : null,
    backend: manifest.backend,
    model: manifest.model,
    effort: manifest.effort,
    sessionName: manifest.sessionName,
    backendSessionId: manifest.backendSessionId,
    cwd: manifest.cwd,
    taskMode: resolvedTaskMode(manifest),
    unrestricted: manifest.unrestricted,
    timeoutSec: manifest.timeoutSec,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    exitCode: manifest.exitCode,
    attempts: manifest.attempts,
    maxAttempts: manifest.maxAttempts,
    tasksCompleted: manifest.tasksCompleted,
    tasksTotal: manifest.tasksTotal,
    tasks: Object.values(manifest.finalTasks).map(toRunTaskSummary),
    message: manifest.message,
    callerInstructions: manifest.callerInstructions,
    pendingPrompt: manifest.pendingPrompt,
    lockedFields: [...manifest.lockedFields],
    runtimeVars: { ...manifest.runtimeVars },
    capabilities: deriveRunCapabilities(manifest),
  };
}

export function toRunArchiveResult(result: {
  manifest: RunManifest;
  changed: boolean;
}): RunArchiveResult {
  return {
    runId: result.manifest.runId,
    status: result.manifest.status,
    archivedAt: result.manifest.archivedAt,
    changed: result.changed,
  };
}
