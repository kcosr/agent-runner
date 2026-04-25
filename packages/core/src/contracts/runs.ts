import type { LockableField } from "../core/config/schema.js";
import type { HookAuditRecord, ResolvedHookDescriptor } from "../core/hooks/types.js";
import {
  type RunDependencyDetail,
  type RunDependencyState,
  deriveDependencyState,
  resolveDependencies,
  resolveDependents,
} from "../core/run/dependencies.js";
import type { RunExecution, RunSchedule, TaskSnapshot } from "../core/run/manifest.js";
import type { ListedRunManifest, ManifestStatus, RunManifest } from "../core/run/manifest.js";
import { type RunScheduleState, deriveScheduleState } from "../core/run/schedule.js";
import { deriveEffectiveStatus } from "../core/run/status.js";
import type { RunAttachment } from "./attachments.js";

// Transport-neutral run DTOs for later CLI/web/daemon surfaces.
// RunManifest remains the internal canonical record; these helpers project
// from it without doing filesystem, env, or process work.
export type RunStatus = ManifestStatus;
export type { RunDependencyDetail, RunDependencyState } from "../core/run/dependencies.js";
export type { RunSchedule, RunScheduleState };

export interface RunActiveTask {
  id: string;
  title: string;
}

export interface RunSessionSummary {
  sessionIndex: number;
  status: RunStatus;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  message: string | null;
  firstAttemptNumber: number | null;
  lastAttemptNumber: number | null;
  attemptCount: number;
  maxAttemptsPerSession: number;
  backendSessionIdAtStart: string | null;
  backendSessionIdAtEnd: string | null;
}

export interface RunSummary {
  runId: string;
  parentRunId: string | null;
  familyRootRunId: string | null;
  repo: string;
  status: RunStatus;
  effectiveStatus: RunStatus;
  archivedAt: string | null;
  pinned: boolean;
  notePresent: boolean;
  agentName: string;
  name: string | null;
  assignmentName: string | null;
  backend: string;
  model: string | null;
  cwd: string;
  startedAt: string;
  endedAt: string | null;
  totalAttemptCount: number;
  totalSessionCount: number;
  maxAttemptsPerSession: number;
  currentSession: RunSessionSummary | null;
  lastSession: RunSessionSummary | null;
  tasksCompleted: number;
  tasksTotal: number;
  attachmentCount: number;
  hookCount?: number;
  dependencyState: RunDependencyState;
  schedule: RunSchedule | null;
  scheduleState: RunScheduleState;
  activeTask: RunActiveTask | null;
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
export type RunReconfigureUnavailableReason = "archived" | "not_initialized";

export interface ReconfigureRunPatch {
  vars?: Record<string, string>;
  message?: string;
}

export interface RunCapabilities {
  canArchive: boolean;
  canUnarchive: boolean;
  canReset: boolean;
  canDelete: boolean;
  canReady: boolean;
  canResume: boolean;
  canAbort: boolean;
  abortReason?: RunAbortReason;
  /**
   * True only for unarchived initialized runs. Reconfigure can patch
   * runtime vars and the initial message; it never changes frozen
   * identity/runtime fields such as agent, assignment, cwd, tasks,
   * launcher, hooks, or backend-specific transport.
   */
  canReconfigure: boolean;
  reconfigureReason?: RunReconfigureUnavailableReason;
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
  parentRunId: string | null;
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
  note: string | null;
  pinned: boolean;
  backendSessionId: string | null;
  cwd: string;
  unrestricted: boolean;
  timeoutSec: number;
  startedAt: string;
  endedAt: string | null;
  exitCode: number | null;
  totalAttemptCount: number;
  totalSessionCount: number;
  maxAttemptsPerSession: number;
  sessions: RunSessionSummary[];
  currentSession: RunSessionSummary | null;
  lastSession: RunSessionSummary | null;
  tasksCompleted: number;
  tasksTotal: number;
  attachments: RunAttachment[];
  resolvedHooks?: ResolvedHookDescriptor[];
  hookState?: Record<string, unknown>;
  hookAudits?: HookAuditRecord[];
  dependencies: RunDependencyDetail[];
  dependents: RunDependencyDetail[];
  schedule: RunSchedule | null;
  scheduleState: RunScheduleState;
  tasks: RunTaskSummary[];
  activeTask: RunActiveTask | null;
  message: string | null;
  pendingPrompt: string | null;
  callerInstructions: string | null;
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

export interface RunNoteResult {
  runId: string;
  note: string | null;
  changed: boolean;
}

export interface RunPinnedResult {
  runId: string;
  pinned: boolean;
  changed: boolean;
}

export interface RunBackendSessionResult {
  runId: string;
  backendSessionId: string | null;
  changed: boolean;
}

export interface RunDependenciesResult {
  runId: string;
  dependencyRunIds: string[];
  changed: boolean;
}

export interface RunDeleteResult {
  runId: string;
}

export type { RunAttachment, RunAttachmentRemoveResult } from "./attachments.js";

export interface RunActionTarget {
  target: string;
}

export interface DaemonAutoRunnableInput {
  manifest: Pick<RunManifest, "status" | "schedule" | "archivedAt" | "backend">;
  dependencyState: Pick<RunDependencyState, "unsatisfied">;
  activeInDaemon: boolean;
  now?: Date;
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

function deriveActiveTask(tasks: Record<string, TaskSnapshot>): RunActiveTask | null {
  const inProgress = Object.values(tasks).filter((task) => task.status === "in_progress");
  if (inProgress.length !== 1) {
    return null;
  }
  const [task] = inProgress;
  if (!task) {
    return null;
  }

  return {
    id: task.id,
    title: task.title,
  };
}

function toRunSessionSummaries(manifest: RunManifest): RunSessionSummary[] {
  const attemptsBySession = new Map<number, number>();
  for (const attempt of manifest.attemptRecords) {
    attemptsBySession.set(
      attempt.sessionIndex,
      (attemptsBySession.get(attempt.sessionIndex) ?? 0) + 1,
    );
  }

  return [...manifest.sessions]
    .sort((a, b) => a.sessionIndex - b.sessionIndex)
    .map((session) => ({
      sessionIndex: session.sessionIndex,
      status: session.status,
      startedAt: session.startedAt,
      endedAt: session.endedAt,
      exitCode: session.exitCode,
      message: session.message,
      firstAttemptNumber: session.firstAttemptNumber,
      lastAttemptNumber: session.lastAttemptNumber,
      attemptCount: attemptsBySession.get(session.sessionIndex) ?? 0,
      maxAttemptsPerSession: session.maxAttemptsPerSession,
      backendSessionIdAtStart: session.backendSessionIdAtStart,
      backendSessionIdAtEnd: session.backendSessionIdAtEnd,
    }));
}

function deriveCurrentSession(
  manifest: RunManifest,
  sessions: RunSessionSummary[],
): RunSessionSummary | null {
  if (manifest.status !== "running") {
    return null;
  }
  return sessions.find((session) => session.status === "running") ?? null;
}

function deriveLastSession(sessions: RunSessionSummary[]): RunSessionSummary | null {
  return sessions.at(-1) ?? null;
}

function isArchived(manifest: RunManifest): boolean {
  return manifest.archivedAt !== null;
}

function isRunning(manifest: RunManifest): boolean {
  return manifest.status === "running";
}

export function canArchiveRun(manifest: RunManifest): boolean {
  return !isRunning(manifest) && !isArchived(manifest);
}

export function canUnarchiveRun(manifest: RunManifest): boolean {
  return !isRunning(manifest) && isArchived(manifest);
}

export function canResetRun(manifest: RunManifest): boolean {
  return !isRunning(manifest);
}

export function canDeleteRun(manifest: RunManifest): boolean {
  return !isRunning(manifest) && isArchived(manifest);
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

export function scheduleIsDueOrAbsent(
  schedule: RunSchedule | null,
  now: Date = new Date(),
): boolean {
  const state = deriveScheduleState(schedule, now);
  return state === "none" || state === "due";
}

export function isDaemonAutoRunnableReadyRun(input: DaemonAutoRunnableInput): boolean {
  return (
    input.manifest.status === "ready" &&
    input.dependencyState.unsatisfied === 0 &&
    scheduleIsDueOrAbsent(input.manifest.schedule, input.now) &&
    !input.activeInDaemon &&
    input.manifest.archivedAt === null &&
    input.manifest.backend !== "passive"
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
    case "ready":
      return {
        canSetStatus: false,
        canEditNotes: true,
        canAdd: false,
      };
    case "running": {
      return {
        canSetStatus: true,
        canEditNotes: true,
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
  familyRootRunId: string | null = null,
): RunSummary {
  const resolvedDependencyState =
    dependencyState ?? deriveDependencyState(entry.manifest, relatedManifests);
  const sessions = toRunSessionSummaries(entry.manifest);
  const scheduleState = deriveScheduleState(entry.manifest.schedule);
  return {
    runId: entry.manifest.runId,
    parentRunId: entry.manifest.parentRunId,
    familyRootRunId,
    repo: entry.manifest.repo,
    status: entry.manifest.status,
    effectiveStatus: deriveEffectiveStatus(entry.manifest),
    archivedAt: entry.manifest.archivedAt,
    pinned: entry.manifest.pinned,
    notePresent: entry.manifest.note !== null,
    agentName: entry.manifest.agent.name,
    name: entry.manifest.name,
    assignmentName: entry.manifest.assignment?.name ?? null,
    backend: entry.manifest.backend,
    model: entry.manifest.model,
    cwd: entry.manifest.cwd,
    startedAt: entry.manifest.startedAt,
    endedAt: entry.manifest.endedAt,
    totalAttemptCount: entry.manifest.totalAttemptCount,
    totalSessionCount: entry.manifest.totalSessionCount,
    maxAttemptsPerSession: entry.manifest.maxAttemptsPerSession,
    currentSession: deriveCurrentSession(entry.manifest, sessions),
    lastSession: deriveLastSession(sessions),
    tasksCompleted: entry.manifest.tasksCompleted,
    tasksTotal: entry.manifest.tasksTotal,
    attachmentCount: entry.manifest.attachments.length,
    hookCount: entry.manifest.resolvedHooks.length,
    dependencyState: resolvedDependencyState,
    schedule: entry.manifest.schedule,
    scheduleState,
    activeTask: deriveActiveTask(entry.manifest.finalTasks),
    execution: entry.manifest.execution,
    capabilities: deriveRunCapabilities(entry.manifest, resolvedDependencyState),
  };
}

function isReadyRunBlockedOnDependencies(
  status: RunStatus,
  dependencyState?: Pick<RunDependencyState, "unsatisfied">,
): boolean {
  return status === "ready" && (dependencyState?.unsatisfied ?? 0) > 0;
}

export function deriveRunCapabilities(
  manifest: RunManifest,
  dependencyState?: Pick<RunDependencyState, "unsatisfied">,
): RunCapabilities {
  const canAbort = false;
  const archived = isArchived(manifest);
  const canReconfigure = !archived && manifest.status === "initialized";
  const nonPassive = manifest.backend !== "passive";
  const dependencyBlockedReadyRun = isReadyRunBlockedOnDependencies(
    manifest.status,
    dependencyState,
  );
  return {
    canArchive: canArchiveRun(manifest),
    canUnarchive: canUnarchiveRun(manifest),
    canReset: canResetRun(manifest),
    canDelete: canDeleteRun(manifest),
    canReady: !archived && nonPassive && manifest.status === "initialized",
    canResume:
      !isRunning(manifest) &&
      !archived &&
      nonPassive &&
      manifest.status !== "initialized" &&
      !dependencyBlockedReadyRun,
    canAbort,
    abortReason: canAbort
      ? undefined
      : isTerminalStatus(manifest.status)
        ? "already_terminal"
        : "not_active_in_daemon",
    canReconfigure,
    reconfigureReason: canReconfigure ? undefined : archived ? "archived" : "not_initialized",
    taskMutation: deriveTaskMutationCapabilities(manifest),
  };
}

export function toRunDetail(result: RunDetailInput): RunDetail {
  const { manifest } = result;
  const relatedManifests =
    result.relatedManifests ?? new Map<string, RunManifest>([[manifest.runId, manifest]]);
  const dependencyState = deriveDependencyState(manifest, relatedManifests);
  const sessions = toRunSessionSummaries(manifest);
  const scheduleState = deriveScheduleState(manifest.schedule);
  return {
    runId: manifest.runId,
    parentRunId: manifest.parentRunId,
    repo: manifest.repo,
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
    note: manifest.note,
    pinned: manifest.pinned,
    backendSessionId: manifest.backendSessionId,
    cwd: manifest.cwd,
    unrestricted: manifest.unrestricted,
    timeoutSec: manifest.timeoutSec,
    startedAt: manifest.startedAt,
    endedAt: manifest.endedAt,
    exitCode: manifest.exitCode,
    totalAttemptCount: manifest.totalAttemptCount,
    totalSessionCount: manifest.totalSessionCount,
    maxAttemptsPerSession: manifest.maxAttemptsPerSession,
    sessions,
    currentSession: deriveCurrentSession(manifest, sessions),
    lastSession: deriveLastSession(sessions),
    tasksCompleted: manifest.tasksCompleted,
    tasksTotal: manifest.tasksTotal,
    attachments: manifest.attachments.map((attachment) => ({ ...attachment })),
    resolvedHooks: manifest.resolvedHooks.map((descriptor) => ({
      hookId: descriptor.hookId,
      phase: descriptor.phase,
      source: { ...descriptor.source },
      resolvedPath: descriptor.resolvedPath,
      taskScopeId: descriptor.taskScopeId ?? null,
      when: descriptor.when ? { ...descriptor.when } : null,
      config: descriptor.config,
    })),
    hookState: { ...manifest.hookState },
    hookAudits: manifest.hookAudits.map((audit) => ({
      phase: audit.phase,
      hookId: audit.hookId,
      startedAt: audit.startedAt,
      endedAt: audit.endedAt,
      outcome: audit.outcome,
      sessionIndex: audit.sessionIndex,
      attemptNumber: audit.attemptNumber,
      taskId: audit.taskId,
      summary: audit.summary ?? null,
    })),
    dependencies: result.dependencies ?? resolveDependencies(manifest, relatedManifests),
    dependents: result.dependents ?? resolveDependents(manifest, relatedManifests),
    schedule: manifest.schedule,
    scheduleState,
    tasks: Object.values(manifest.finalTasks).map(toRunTaskSummary),
    activeTask: deriveActiveTask(manifest.finalTasks),
    message: manifest.message,
    pendingPrompt:
      (manifest.status === "initialized" || manifest.status === "ready") &&
      manifest.totalAttemptCount === 0
        ? manifest.brief
        : null,
    callerInstructions: manifest.callerInstructions,
    lockedFields: [...manifest.lockedFields],
    runtimeVars: redactRuntimeVarsForDisplay(manifest),
    execution: manifest.execution,
    capabilities: deriveRunCapabilities(manifest, dependencyState),
  };
}

function redactRuntimeVarsForDisplay(manifest: RunManifest): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(manifest.runtimeVars)) {
    const source = manifest.runtimeVarSources[key];
    if (source?.redacted && source.envName) {
      out[key] = {
        redacted: true,
        source: source.source === "parent" ? "parent" : "env",
        envName: source.envName,
        ...(source.inheritedFromRunId ? { inheritedFromRunId: source.inheritedFromRunId } : {}),
      };
      continue;
    }
    out[key] = value;
  }
  return out;
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

export function toRunNoteResult(result: {
  manifest: RunManifest;
  changed: boolean;
}): RunNoteResult {
  return {
    runId: result.manifest.runId,
    note: result.manifest.note,
    changed: result.changed,
  };
}

export function toRunPinnedResult(result: {
  manifest: RunManifest;
  changed: boolean;
}): RunPinnedResult {
  return {
    runId: result.manifest.runId,
    pinned: result.manifest.pinned,
    changed: result.changed,
  };
}

export function toRunBackendSessionResult(result: {
  manifest: RunManifest;
  changed: boolean;
}): RunBackendSessionResult {
  return {
    runId: result.manifest.runId,
    backendSessionId: result.manifest.backendSessionId,
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
