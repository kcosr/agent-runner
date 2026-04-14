import { deriveRepoKey } from "../config/runtime-paths.js";
import { normalizeTaskMode } from "../core/config/schema.js";
import type { LockableField, TaskMode } from "../core/config/schema.js";
import {
  type RunDependencyDetail,
  type RunDependencyState,
  deriveDependencyState,
  resolveDependencies,
  resolveDependents,
} from "../core/run/dependencies.js";
import type { RunExecution, TaskSnapshot } from "../core/run/manifest.js";
import type { ListedRunManifest, ManifestStatus, RunManifest } from "../core/run/manifest.js";
import { deriveEffectiveStatus } from "../core/run/status.js";

// Transport-neutral run DTOs for later CLI/web/daemon surfaces.
// RunManifest remains the internal canonical record; these helpers project
// from it without doing filesystem, env, or process work.
export type RunStatus = ManifestStatus;
export type { RunDependencyDetail, RunDependencyState } from "../core/run/dependencies.js";

export interface RunSummary {
  runId: string;
  repo: string;
  status: RunStatus;
  effectiveStatus: RunStatus;
  archivedAt: string | null;
  agentName: string;
  name: string | null;
  assignmentName: string | null;
  backend: string;
  model: string | null;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  tasksCompleted: number;
  tasksTotal: number;
  dependencyState: RunDependencyState;
  execution: RunExecution;
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

export type RunAbortReason = "already_terminal" | "not_active_in_daemon";

export interface RunCapabilities {
  canArchive: boolean;
  canUnarchive: boolean;
  canResume: boolean;
  canAbort: boolean;
  abortReason?: RunAbortReason;
  taskMutation: RunTaskMutationCapabilities;
}

export interface RunDetailInput {
  manifest: RunManifest;
  isLive: boolean;
  relatedManifests?: ReadonlyMap<string, RunManifest>;
  dependencies?: RunDependencyDetail[];
  dependents?: RunDependencyDetail[];
}

export interface RunDetail {
  runId: string;
  repo: string;
  status: RunStatus;
  effectiveStatus: RunStatus;
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
  name: string | null;
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
  dependencies: RunDependencyDetail[];
  dependents: RunDependencyDetail[];
  tasks: RunTaskSummary[];
  message: string | null;
  callerInstructions: string | null;
  pendingPrompt: string | null;
  lockedFields: LockableField[];
  runtimeVars: Record<string, unknown>;
  execution: RunExecution;
  capabilities: RunCapabilities;
}

export interface RunArchiveResult {
  runId: string;
  status: RunStatus;
  archivedAt: string | null;
  changed: boolean;
}

export interface RunNameResult {
  runId: string;
  name: string | null;
  changed: boolean;
}

export interface RunDependenciesResult {
  runId: string;
  dependencyRunIds: string[];
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

export function isTerminalStatus(status: RunStatus): boolean {
  return (
    status === "success" ||
    status === "blocked" ||
    status === "exhausted" ||
    status === "aborted" ||
    status === "error"
  );
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

export function toRunSummary(
  entry: ListedRunManifest,
  relatedManifests: ReadonlyMap<string, RunManifest> = new Map([
    [entry.manifest.runId, entry.manifest],
  ]),
  dependencyState?: RunDependencyState,
): RunSummary {
  return {
    runId: entry.manifest.runId,
    repo: entry.repo,
    status: entry.manifest.status,
    effectiveStatus: deriveEffectiveStatus(entry.manifest),
    archivedAt: entry.manifest.archivedAt,
    agentName: entry.manifest.agent.name,
    name: entry.manifest.name,
    assignmentName: entry.manifest.assignment?.name ?? null,
    backend: entry.manifest.backend,
    model: entry.manifest.model,
    cwd: entry.manifest.cwd,
    startedAt: entry.manifest.startedAt,
    endedAt: entry.manifest.endedAt,
    tasksCompleted: entry.manifest.tasksCompleted,
    tasksTotal: entry.manifest.tasksTotal,
    dependencyState: dependencyState ?? deriveDependencyState(entry.manifest, relatedManifests),
    execution: entry.manifest.execution,
    capabilities: deriveRunCapabilities(entry.manifest),
  };
}

export function deriveRunCapabilities(manifest: RunManifest): RunCapabilities {
  const canAbort = false;
  return {
    canArchive: !isRunning(manifest) && !isArchived(manifest),
    canUnarchive: !isRunning(manifest) && isArchived(manifest),
    canResume: !isRunning(manifest) && !isArchived(manifest) && manifest.backend !== "passive",
    canAbort,
    abortReason: canAbort
      ? undefined
      : isTerminalStatus(manifest.status)
        ? "already_terminal"
        : "not_active_in_daemon",
    taskMutation: deriveTaskMutationCapabilities(manifest),
  };
}

export function toRunDetail(result: RunDetailInput): RunDetail {
  const { manifest } = result;
  const relatedManifests =
    result.relatedManifests ?? new Map<string, RunManifest>([[manifest.runId, manifest]]);
  return {
    runId: manifest.runId,
    repo: deriveRepoKey(manifest.cwd),
    status: manifest.status,
    effectiveStatus: deriveEffectiveStatus(manifest),
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
    name: manifest.name,
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
    dependencies: result.dependencies ?? resolveDependencies(manifest, relatedManifests),
    dependents: result.dependents ?? resolveDependents(manifest, relatedManifests),
    tasks: Object.values(manifest.finalTasks).map(toRunTaskSummary),
    message: manifest.message,
    callerInstructions: manifest.callerInstructions,
    pendingPrompt: manifest.pendingPrompt,
    lockedFields: [...manifest.lockedFields],
    runtimeVars: { ...manifest.runtimeVars },
    execution: manifest.execution,
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

export function toRunNameResult(result: {
  manifest: RunManifest;
  changed: boolean;
}): RunNameResult {
  return {
    runId: result.manifest.runId,
    name: result.manifest.name,
    changed: result.changed,
  };
}

export function toRunDependenciesResult(result: {
  manifest: RunManifest;
  changed: boolean;
}): RunDependenciesResult {
  return {
    runId: result.manifest.runId,
    dependencyRunIds: [...result.manifest.dependencyRunIds],
    changed: result.changed,
  };
}
