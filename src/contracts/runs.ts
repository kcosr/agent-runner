import { normalizeTaskMode } from "../core/config/schema.js";
import type { LockableField, TaskMode } from "../core/config/schema.js";
import type { TaskSnapshot } from "../core/run/manifest.js";
import type { ListedRunManifest, ManifestStatus, RunManifest } from "../core/run/manifest.js";

// Transport-neutral run DTOs for later CLI/web/daemon surfaces.
// RunManifest remains the internal canonical record; these helpers project
// from it without doing filesystem, env, or process work.
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
  capabilities: RunCapabilities;
}

export interface RunTaskSummary {
  id: string;
  title: string;
  body: string;
  status: TaskSnapshot["status"];
  notes: string;
}

export interface RunTaskMutationCapabilities {
  canSetStatus: boolean;
  canEditNotes: boolean;
  canAdd: boolean;
}

export interface RunCapabilities {
  canArchive: boolean;
  canUnarchive: boolean;
  canResume: boolean;
  taskMutation: RunTaskMutationCapabilities;
}

export interface RunDetailInput {
  manifest: RunManifest;
  isLive: boolean;
}

export interface RunDetail {
  runId: string;
  status: RunStatus;
  archivedAt: string | null;
  isLive: boolean;
  workspaceDir: string;
  assignmentPath: string;
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
  sessionCount: number;
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

function toRunTaskSummary(task: TaskSnapshot): RunTaskSummary {
  return {
    id: task.id,
    title: task.title,
    body: task.body,
    status: task.status,
    notes: task.notes,
  };
}

function isArchived(manifest: RunManifest): boolean {
  return manifest.archivedAt !== null;
}

function isRunning(manifest: RunManifest): boolean {
  return manifest.status === "running";
}

export function deriveTaskMutationCapabilities(manifest: RunManifest): RunTaskMutationCapabilities {
  const tasksLocked = manifest.lockedFields.includes("tasks");

  if (manifest.backend === "passive") {
    return {
      canSetStatus: !isRunning(manifest),
      canEditNotes: !isRunning(manifest),
      canAdd: !isRunning(manifest) && !tasksLocked,
    };
  }

  switch (manifest.status) {
    case "initialized":
      return {
        canSetStatus: true,
        canEditNotes: true,
        canAdd: !tasksLocked,
      };
    case "running": {
      const canMutateRunningTasks = normalizeTaskMode(manifest.taskMode) === "cli";
      return {
        canSetStatus: canMutateRunningTasks,
        canEditNotes: canMutateRunningTasks,
        canAdd: false,
      };
    }
    case "success":
    case "blocked":
    case "exhausted":
    case "aborted":
    case "error":
      return {
        canSetStatus: false,
        canEditNotes: true,
        canAdd: false,
      };
  }
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
    capabilities: deriveRunCapabilities(entry.manifest),
  };
}

export function deriveRunCapabilities(manifest: RunManifest): RunCapabilities {
  return {
    canArchive: !isRunning(manifest) && !isArchived(manifest),
    canUnarchive: !isRunning(manifest) && isArchived(manifest),
    canResume: !isRunning(manifest) && !isArchived(manifest) && manifest.backend !== "passive",
    taskMutation: deriveTaskMutationCapabilities(manifest),
  };
}

export function toRunDetail(result: RunDetailInput): RunDetail {
  const { manifest } = result;
  return {
    runId: manifest.runId,
    status: manifest.status,
    archivedAt: manifest.archivedAt,
    isLive: result.isLive,
    workspaceDir: manifest.workspaceDir,
    assignmentPath: manifest.assignmentPath,
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
    taskMode: normalizeTaskMode(manifest.taskMode),
    unrestricted: manifest.unrestricted,
    timeoutSec: manifest.timeoutSec,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    exitCode: manifest.exitCode,
    attempts: manifest.attempts,
    maxAttempts: manifest.maxAttempts,
    sessionCount: manifest.sessionCount,
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
