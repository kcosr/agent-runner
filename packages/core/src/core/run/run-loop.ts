import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { TaskState, TaskStatus } from "../../assignment/model.js";
import { BackendConfigError, resolveBackend } from "../../backends/registry.js";
import {
  deriveRepoKey,
  resolveRunWorkspaceDirForRepo,
  resolveTaskRunnerConfigDir,
  resolveTaskRunnerStateDir,
} from "../../config/runtime-paths.js";
import { resolveTaskRunnerCommand } from "../../task-runner-command.js";
import { normalizeOptionalRunName } from "../../util/run-name.js";
import { shortId } from "../../util/short-id.js";
import { appendTextFileDurable } from "../../util/write-file-atomic.js";
import {
  cloneBackendConfig,
  cloneResolvedBackendArgs,
  isJsonishPersistable,
} from "../backends/types.js";
import type {
  Backend,
  BackendEvent,
  BackendInvokeResult,
  BackendName,
  ResolvedBackendArgs,
} from "../backends/types.js";
import { interpolate } from "../config/interpolate.js";
import { type ResolvedLauncherConfig, cloneResolvedLauncherConfig } from "../config/launchers.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import type { LockableField, VarDef } from "../config/schema.js";
import { resolveAssignmentHooks } from "../hooks/loader.js";
import { createHookExecutionState, runAttemptHooks, runPrepareHooks } from "../hooks/runtime.js";
import type { ResolvedHookDescriptor } from "../hooks/types.js";
import {
  buildEnvironmentLauncher,
  cleanupExecutionEnvironment,
  prepareExecutionEnvironment,
  resolveFreshExecutionEnvironment,
} from "./execution-environments.js";
import { validateRunGroupId } from "./groups.js";
import {
  interpolateResolvedLauncher,
  launcherAppliesToBackend,
  resolveFreshLauncherConfig,
} from "./launchers.js";
import {
  type AttemptRecord,
  type ResolvedResumeTarget,
  ResumeError,
  type RunExecution,
  type RunManifest,
  type RunSchedule,
  type RuntimeVarSourceRecord,
  type SessionRecord,
  type TaskSnapshot,
  applyRunResetSeed,
  attemptStdoutLogRelativePath,
  buildRunResetSeed,
  cloneRunDependencyRefs,
  cloneRuntimeVarSources,
  findRunManifestsById,
  listRunManifests,
  resolveResumeTarget,
  snapshotTasks,
  workspaceAgentPath,
  workspaceAssignmentPath,
  writeAttemptLog,
  writeManifest,
} from "./manifest.js";
import { buildNudgeMessage } from "./nudge.js";
import {
  type RecursionState,
  buildChildRecursionEnv,
  checkRecursionDepth,
  readParentRunIdFromEnv,
  readRecursionState,
  readRunGroupIdFromEnv,
} from "./recursion-guard.js";
import {
  IMPLICIT_RESUME_MESSAGE,
  hasRunnableTasks,
  missingResumeInputMessage,
} from "./resume-policy.js";
import {
  type RunAuditEnvelope,
  appendRunAbortedEvent,
  appendRunAttemptRecordedEvent,
  appendRunBackendSessionHistoryImportedEvent,
  appendRunBackendSessionHistorySyncFailedEvent,
  appendRunBackendSessionHistorySyncedEvent,
  appendRunBackendSessionUpdatedEvent,
  appendRunContainerCleanupFailedEvent,
  appendRunContainerCreatedEvent,
  appendRunContainerRemovedEvent,
  appendRunCreatedEvent,
  appendRunEnvironmentValidatedEvent,
  appendRunEnvironmentValidationFailedEvent,
  appendRunFinishedEvent,
  appendRunResumeRejectedEvent,
  appendRunRetryingEvent,
  appendRunScheduleAdvancedEvent,
  appendRunScheduleConsumedEvent,
  appendRunScheduleDisabledEvent,
  appendRunStartedEvent,
  lifecycleRunEventContext,
} from "./run-events.js";
import {
  type ScheduleInput,
  ScheduleValidationError,
  advanceRecurringSchedule,
  resolveScheduleInput,
} from "./schedule.js";
import { resolveFreshRunMaxRetries } from "./static-input-surface.js";
import type { RunCompletionStatus, RunCompletionSummary } from "./status.js";

export { RecursionDepthError } from "./recursion-guard.js";
import {
  type BackendSessionHistorySyncPreparation,
  type BackendSessionHistorySyncResult,
  applyPreparedBackendSessionHistorySync,
  importBackendSessionHistoryForInitialManifest,
  prepareBackendSessionHistorySync,
  recordBackendSessionSyncError,
} from "./backend-session-sync.js";
import { WORKER_BRIEF_TEMPLATE, buildAddedTasksReminder } from "./task-workflow.js";
import {
  refreshManifestAttachments,
  refreshManifestTaskState,
  syncManifestTaskState,
  withTaskStateLock,
  withTaskStateLockAsync,
} from "./workspace-state.js";

export interface RunOverrides {
  cwd?: string;
  backend?: BackendName;
  launcher?: string;
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
  executionEnvironment?: string;
}

export interface RunOptions {
  loaded: LoadedAgent;
  loadedAssignment?: LoadedAssignment;
  cliVars: Record<string, string>;
  webVars: Record<string, string>;
  parentRunId?: string | null;
  runGroupId?: string | null;
  backend: Backend;
  callerCwd?: string;
  overrides?: RunOverrides;
  resume?: ResolvedResumeTarget;
  initialize?: boolean;
  /**
   * Adopt an existing backend session id (claude session UUID, codex
   * thread id) instead of starting a fresh backend session. Forbidden
   * with `--resume-run` (the resume target already carries one).
   * `runAgent` validates the id via `backend.validateSessionId` (if
   * the backend implements it) before any workspace creation; on
   * failure, throws `InvalidBackendSessionError` and exits cleanly.
   * On success, the id is persisted as `manifest.backendSessionId`
   * and used as the initial `resumeSessionId` for the first attempt.
   */
  bootstrapBackendSessionId?: string;
  execution?: RunExecution;
  abortSignal?: AbortSignal;
  emitEvent?: (event: RunEvent) => void;
  emitAuditEnvelope?: (envelope: RunAuditEnvelope) => void;
  resumeFailureDetector?: (result: BackendInvokeResult) => boolean;
  stageInitialize?: boolean;
  resolvedHooksOverride?: ResolvedHookDescriptor[];
}

export interface RunOutcome {
  summary: RunCompletionSummary;
  exitCode: number;
  attemptTranscripts: string[];
  runId: string;
  workspaceDir: string;
  manifest: RunManifest;
}

export type RunEvent =
  | {
      type: "run_initialized";
      runId: string;
      agentName: string;
      assignmentSourcePath: string | null;
      name: string | null;
      cwd: string;
      passive: boolean;
      brief: string;
    }
  | {
      type: "caller_instructions";
      text: string;
    }
  | {
      type: "run_started";
      runId: string;
      agentName: string;
      assignmentSourcePath: string | null;
      name: string | null;
      cwd: string;
      sessionIndex: number | null;
    }
  | {
      type: "timeline_invalidated";
      reason: "backend_session_sync";
    }
  | {
      type: "attempt_started";
      attemptNumber: number;
      sessionIndex: number;
      attemptIndexInSession: number;
      startedAt: string;
      prompt: string;
    }
  | BackendEvent
  | {
      type: "retrying";
      incompleteCount: number;
      invalidStatusCount: number;
    }
  | {
      type: "run_aborted";
    }
  | {
      type: "resume_rejected";
    }
  | {
      type: "run_finished";
      summary: RunCompletionSummary;
    };

export class VarResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VarResolutionError";
  }
}

export class EmptyPromptError extends Error {
  constructor() {
    super(
      "agent has no prompt content\n" +
        "  the run has no agent instructions, no assignment instructions,\n" +
        "  no `message` (CLI positional or assignment default), and no tasks.\n" +
        "  At least one is required.",
    );
    this.name = "EmptyPromptError";
  }
}

export class InvalidAddedTaskError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidAddedTaskError";
  }
}

export class InvalidRunNameError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidRunNameError";
  }
}

export class InvalidBackendSessionError extends Error {
  constructor(
    public readonly sessionId: string,
    public readonly reason: string,
  ) {
    super(`invalid backend session id "${sessionId}":\n${reason}`);
    this.name = "InvalidBackendSessionError";
  }
}

export class LockedFieldError extends Error {
  constructor(
    public readonly field: LockableField,
    public readonly currentValue: unknown,
  ) {
    const valStr =
      currentValue === undefined || currentValue === null
        ? "(unset)"
        : typeof currentValue === "string"
          ? `"${currentValue}"`
          : String(currentValue);
    super(`cannot override locked field: ${field}\n  this run fixes it to ${valStr}`);
    this.name = "LockedFieldError";
  }
}

function checkLockedFields(
  agentConfig: LoadedAgent["config"],
  assignmentConfig: LoadedAssignment["config"] | undefined,
  agentInstructions: string,
  assignmentInstructions: string,
  overrides: RunOverrides | undefined,
  addedTasks: string[],
): void {
  const locked = new Set<LockableField>([
    ...agentConfig.lockedFields,
    ...(assignmentConfig?.lockedFields ?? []),
  ]);
  if (locked.size === 0) return;

  const overrideEntries: [LockableField, unknown, unknown][] = [
    ["cwd", overrides?.cwd, assignmentConfig?.cwd],
    ["backend", overrides?.backend, agentConfig.backend],
    ["model", overrides?.model, agentConfig.model],
    ["effort", overrides?.effort, agentConfig.effort],
    ["message", overrides?.message, assignmentConfig?.message],
    ["timeoutSec", overrides?.timeoutSec, agentConfig.timeoutSec],
    ["unrestricted", overrides?.unrestricted, agentConfig.unrestricted],
    ["maxRetries", overrides?.maxRetries, assignmentConfig?.maxRetries],
    ["tasks", addedTasks.length > 0 ? addedTasks : undefined, assignmentConfig?.tasks ?? []],
    ["schedule", overrides?.schedule, assignmentConfig?.schedule],
    [
      "instructions",
      assignmentInstructions.trim().length > 0 ? assignmentInstructions : undefined,
      agentInstructions,
    ],
  ];

  for (const [key, value, currentValue] of overrideEntries) {
    if (value !== undefined && locked.has(key)) {
      throw new LockedFieldError(key, currentValue);
    }
  }
}

// Re-check overrides against the frozen manifest's lockedFields. Used
// for ready-start as a defense-in-depth backstop — the explicit
// per-field "no overrides on ready start" list
// above should already have rejected everything, but if a future
// RunOverrides field is added and someone forgets to add it to the
// explicit list, this re-check still enforces any relevant lock
// against the frozen manifest state. Cheap and catches regressions.
function checkLockedFieldsFromManifest(
  manifest: RunManifest,
  overrides: RunOverrides | undefined,
  addedTasks: string[],
): void {
  const locked = new Set<LockableField>(manifest.lockedFields);
  if (locked.size === 0) return;

  const overrideEntries: [LockableField, unknown, unknown][] = [
    ["cwd", overrides?.cwd, manifest.cwd],
    ["backend", overrides?.backend, manifest.backend],
    ["model", overrides?.model, manifest.model],
    ["effort", overrides?.effort, manifest.effort],
    ["message", overrides?.message, manifest.message],
    ["timeoutSec", overrides?.timeoutSec, manifest.timeoutSec],
    ["unrestricted", overrides?.unrestricted, manifest.unrestricted],
    // maxRetries is stored on the manifest as maxAttemptsPerSession (= retries + 1)
    // so the error message subtracts back to the authored value.
    ["maxRetries", overrides?.maxRetries, manifest.maxAttemptsPerSession - 1],
    ["tasks", addedTasks.length > 0 ? addedTasks : undefined, undefined],
    ["schedule", overrides?.schedule, manifest.schedule],
  ];

  for (const [key, value, currentValue] of overrideEntries) {
    if (value !== undefined && locked.has(key)) {
      throw new LockedFieldError(key, currentValue);
    }
  }
}

function buildResumeSessionManifest(
  base: RunManifest,
  initialPrompt: string,
  overrides: {
    model: string | null;
    effort: RunManifest["effort"];
    launcher: ResolvedLauncherConfig;
    name: string | null;
    unrestricted: boolean;
    cwd: string;
    timeoutSec: number;
    workspaceDir: string;
    maxAttemptsPerSession: number;
    execution: RunExecution;
    totalSessionCount: number;
  },
): RunManifest {
  return {
    ...base,
    model: overrides.model,
    effort: overrides.effort,
    resolvedBackendArgs: cloneResolvedBackendArgs(base.resolvedBackendArgs),
    launcher: cloneResolvedLauncherConfig(overrides.launcher),
    brief: initialPrompt,
    name: overrides.name,
    unrestricted: overrides.unrestricted,
    cwd: overrides.cwd,
    timeoutSec: overrides.timeoutSec,
    workspaceDir: overrides.workspaceDir,
    endedAt: null,
    status: "running",
    exitCode: null,
    maxAttemptsPerSession: overrides.maxAttemptsPerSession,
    execution: overrides.execution,
    finalTasks: {},
    tasksCompleted: 0,
    tasksTotal: 0,
    totalSessionCount: overrides.totalSessionCount,
  };
}

const MAX_TITLE_LENGTH = 200;
const TASK_RUNNER_RUN_ID_ENV = "TASK_RUNNER_RUN_ID";
const TASK_RUNNER_CWD_ENV = "TASK_RUNNER_CWD";

function validateAddedTaskTitle(title: string, index: number): void {
  const trimmed = title.trim();
  if (trimmed.length === 0) {
    throw new InvalidAddedTaskError(`--add-task #${index + 1}: title cannot be empty`);
  }
  if (trimmed.length > MAX_TITLE_LENGTH) {
    throw new InvalidAddedTaskError(
      `--add-task #${index + 1}: title exceeds ${MAX_TITLE_LENGTH} characters (${trimmed.length})`,
    );
  }
}

function normalizeRunName(value: string | undefined): string | null {
  try {
    return normalizeOptionalRunName(value);
  } catch {
    throw new InvalidRunNameError("--name cannot be empty");
  }
}

function refreshMutableManifestMetadata(manifest: RunManifest): void {
  const latest = resolveResumeTarget(manifest.workspaceDir).manifest;
  manifest.name = latest.name;
  manifest.note = latest.note;
  manifest.pinned = latest.pinned;
  manifest.schedule = latest.schedule;
  manifest.queuedResumeMessages = latest.queuedResumeMessages.map((message) => ({ ...message }));
  manifest.resetSeed.name = latest.resetSeed.name;
  manifest.resetSeed.note = latest.resetSeed.note;
  manifest.resetSeed.pinned = latest.resetSeed.pinned;
  manifest.attachments = latest.attachments.map((attachment) => ({ ...attachment }));
}

function tryRefreshMutableManifestMetadata(manifest: RunManifest): void {
  try {
    refreshMutableManifestMetadata(manifest);
  } catch {
    // Mutable metadata refresh is best-effort; keep the in-memory fields if
    // the manifest cannot be re-read transiently.
  }
}

function cloneRunSchedule(schedule: RunSchedule | null): RunSchedule | null {
  if (schedule === null) return null;
  return {
    enabled: schedule.enabled,
    runAt: schedule.runAt,
    recurrence:
      schedule.recurrence === null
        ? null
        : {
            schedule: { ...schedule.recurrence.schedule },
            mode: schedule.recurrence.mode,
            continueOnFailure: schedule.recurrence.continueOnFailure,
          },
  };
}

function cloneTaskSnapshotRecord(
  tasks: Record<string, TaskSnapshot>,
): Record<string, TaskSnapshot> {
  return Object.fromEntries(Object.entries(tasks).map(([taskId, task]) => [taskId, { ...task }]));
}

function consumeOneTimeScheduleForManualStart(
  manifest: RunManifest,
  lifecycleContext: ReturnType<typeof lifecycleRunEventContext>,
  emitAuditEnvelope: (envelope: RunAuditEnvelope) => void,
): void {
  const schedule = manifest.schedule;
  if (schedule === null || schedule.recurrence !== null) {
    return;
  }
  manifest.schedule = null;
  emitAuditEnvelope(
    appendRunScheduleConsumedEvent({
      manifest,
      context: lifecycleContext,
      schedule,
    }),
  );
}

function copySeedAttachments(sourceManifest: RunManifest, targetManifest: RunManifest): void {
  for (const attachment of targetManifest.attachments) {
    const sourcePath = join(sourceManifest.workspaceDir, attachment.relativePath);
    const targetPath = join(targetManifest.workspaceDir, attachment.relativePath);
    mkdirSync(dirname(targetPath), { recursive: true });
    copyFileSync(sourcePath, targetPath);
  }
}

function copyFrozenAssignmentSeed(sourceManifest: RunManifest, targetWorkspaceDir: string): void {
  if (sourceManifest.assignment === null) {
    return;
  }
  const targetAssignmentPath = workspaceAssignmentPath(targetWorkspaceDir);
  mkdirSync(dirname(targetAssignmentPath), { recursive: true });
  copyFileSync(workspaceAssignmentPath(sourceManifest.workspaceDir), targetAssignmentPath);
}

function copyFrozenAgentSeed(sourceManifest: RunManifest, targetWorkspaceDir: string): void {
  if (sourceManifest.agent.sourcePath === null) {
    return;
  }
  const targetAgentPath = workspaceAgentPath(targetWorkspaceDir);
  mkdirSync(dirname(targetAgentPath), { recursive: true });
  copyFileSync(workspaceAgentPath(sourceManifest.workspaceDir), targetAgentPath);
}

function buildRecurringCloneManifest(params: {
  sourceManifest: RunManifest;
  schedule: RunSchedule;
  now: string;
}): RunManifest {
  const { sourceManifest, schedule, now } = params;
  const seed = sourceManifest.resetSeed;
  const runId = shortId();
  const workspaceDir = resolveRunWorkspaceDirForRepo(sourceManifest.repo, runId);
  const finalTasks = cloneTaskSnapshotRecord(seed.finalTasks);
  return {
    schemaVersion: 22,
    runId,
    repo: sourceManifest.repo,
    agent: {
      name: sourceManifest.agent.name,
      sourcePath: sourceManifest.agent.sourcePath,
      instructions: sourceManifest.agent.instructions,
    },
    assignment:
      sourceManifest.assignment === null
        ? null
        : {
            name: sourceManifest.assignment.name,
            sourcePath: sourceManifest.assignment.sourcePath,
          },
    backend: seed.backend,
    model: seed.model,
    effort: seed.effort,
    backendConfig: cloneBackendConfig(seed.backendConfig),
    resolvedBackendArgs: cloneResolvedBackendArgs(seed.resolvedBackendArgs),
    launcher: cloneResolvedLauncherConfig(seed.launcher),
    message: seed.message,
    name: seed.name,
    note: seed.note,
    pinned: seed.pinned,
    unrestricted: seed.unrestricted,
    cwd: seed.cwd,
    lockedFields: [...seed.lockedFields],
    timeoutSec: seed.timeoutSec,
    workspaceDir,
    startedAt: now,
    updatedAt: now,
    endedAt: null,
    archivedAt: null,
    status: "ready",
    runGroupId: seed.runGroupId,
    dependencies: cloneRunDependencyRefs(seed.dependencies),
    parentRunId: seed.parentRunId,
    schedule: cloneRunSchedule(schedule),
    queuedResumeMessages: [],
    exitCode: null,
    totalAttemptCount: 0,
    maxAttemptsPerSession: seed.maxAttemptsPerSession,
    tasksCompleted: Object.values(finalTasks).filter((task) => task.status === "completed").length,
    tasksTotal: Object.keys(finalTasks).length,
    backendSessionId: null,
    backendSessionSync: null,
    runtimeVars: { ...seed.runtimeVars },
    runtimeVarSources: cloneRuntimeVarSources(seed.runtimeVarSources),
    execution: sourceManifest.execution,
    executionEnvironment:
      seed.executionEnvironment?.mode === "managed"
        ? {
            ...seed.executionEnvironment,
            containerName:
              seed.executionEnvironment.lifetime === "group"
                ? seed.executionEnvironment.containerName
                : `task-runner-${runId}`,
            containerId: null,
            workspace:
              seed.executionEnvironment.workspace?.scope === "run" &&
              seed.executionEnvironment.workspace.hostRoot !== null
                ? {
                    ...seed.executionEnvironment.workspace,
                    hostPath: join(seed.executionEnvironment.workspace.hostRoot, runId),
                    createdAt: null,
                  }
                : seed.executionEnvironment.workspace,
            cleanup: {
              ...seed.executionEnvironment.cleanup,
              cleanedAt: null,
              lastError: null,
            },
            lastValidatedAt: null,
            lastError: null,
          }
        : seed.executionEnvironment,
    brief: seed.brief,
    resolvedHooks: sourceManifest.resolvedHooks.map((descriptor) => ({
      ...descriptor,
      source: { ...descriptor.source },
      when: descriptor.when ? { ...descriptor.when } : null,
    })),
    hookState: { ...seed.hookState },
    hookAudits: [],
    callerInstructions: sourceManifest.callerInstructions,
    resetSeed: buildRunResetSeed({
      ...seed,
      backendConfig: cloneBackendConfig(seed.backendConfig),
      resolvedBackendArgs: cloneResolvedBackendArgs(seed.resolvedBackendArgs),
      launcher: cloneResolvedLauncherConfig(seed.launcher),
      executionEnvironment:
        seed.executionEnvironment?.mode === "managed"
          ? {
              ...seed.executionEnvironment,
              containerName:
                seed.executionEnvironment.lifetime === "group"
                  ? seed.executionEnvironment.containerName
                  : `task-runner-${runId}`,
              containerId: null,
              workspace:
                seed.executionEnvironment.workspace?.scope === "run" &&
                seed.executionEnvironment.workspace.hostRoot !== null
                  ? {
                      ...seed.executionEnvironment.workspace,
                      hostPath: join(seed.executionEnvironment.workspace.hostRoot, runId),
                      createdAt: null,
                    }
                  : seed.executionEnvironment.workspace,
              cleanup: {
                ...seed.executionEnvironment.cleanup,
                cleanedAt: null,
                lastError: null,
              },
              lastValidatedAt: null,
              lastError: null,
            }
          : seed.executionEnvironment,
      lockedFields: [...seed.lockedFields],
      runGroupId: seed.runGroupId,
      dependencies: cloneRunDependencyRefs(seed.dependencies),
      parentRunId: seed.parentRunId,
      runtimeVars: { ...seed.runtimeVars },
      runtimeVarSources: cloneRuntimeVarSources(seed.runtimeVarSources),
      hookState: { ...seed.hookState },
      attachments: seed.attachments.map((attachment) => ({ ...attachment })),
      finalTasks,
    }),
    attachments: seed.attachments.map((attachment) => ({ ...attachment })),
    finalTasks,
    totalSessionCount: 0,
    sessions: [],
    attemptRecords: [],
  };
}

function groupEnvironmentHasPendingUsers(manifest: RunManifest): boolean {
  const environment = manifest.executionEnvironment;
  if (environment?.mode !== "managed" || environment.lifetime !== "group") {
    return false;
  }
  return listRunManifests().some(({ manifest: candidate }) => {
    if (candidate.runId === manifest.runId) {
      return false;
    }
    if (
      candidate.runGroupId !== manifest.runGroupId ||
      candidate.executionEnvironment?.mode !== "managed" ||
      candidate.executionEnvironment.lifetime !== "group" ||
      candidate.executionEnvironment.containerName !== environment.containerName
    ) {
      return false;
    }
    return (
      candidate.status === "initialized" ||
      candidate.status === "ready" ||
      candidate.status === "running"
    );
  });
}

function resolveFreshRunCwd(
  assignment: LoadedAssignment | undefined,
  overrides: RunOverrides | undefined,
  callerCwd: string | undefined,
  injectedVars: Record<string, unknown>,
): string {
  const resolutionBase = callerCwd ?? process.cwd();
  if (overrides?.cwd !== undefined) {
    return resolveConfiguredCwd(overrides.cwd, resolutionBase, injectedVars);
  }
  if (assignment?.config.cwd !== undefined) {
    return resolveConfiguredCwd(assignment.config.cwd, resolutionBase, injectedVars);
  }
  return resolutionBase;
}

function captureBackendStdout(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env.TASK_RUNNER_CAPTURE_BACKEND_STDOUT?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

function formatSidecarWriteError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function prepareAttemptStdoutSidecar({
  workspaceDir,
  attemptNumber,
  captureRawBackendStdout,
  emit,
}: {
  workspaceDir: string;
  attemptNumber: number;
  captureRawBackendStdout: boolean;
  emit: (event: BackendEvent) => void;
}): ((line: string) => void) | undefined {
  if (!captureRawBackendStdout) {
    return undefined;
  }

  const relativePath = attemptStdoutLogRelativePath(attemptNumber);
  const rawStdoutLogPath = join(workspaceDir, relativePath);
  let disabled = false;
  const disableCapture = (error: unknown): void => {
    disabled = true;
    emit({
      type: "backend_notice",
      text: `Disabling backend stdout sidecar capture for ${relativePath}: ${formatSidecarWriteError(error)}\n`,
    });
  };

  try {
    appendTextFileDurable(rawStdoutLogPath, "");
  } catch (error) {
    disableCapture(error);
    return undefined;
  }

  return (line: string): void => {
    if (disabled) return;
    try {
      appendTextFileDurable(rawStdoutLogPath, line);
    } catch (error) {
      disableCapture(error);
    }
  };
}

async function resolveFreshBackendConfig(
  backend: Backend,
  agentConfig: LoadedAgent["config"],
  overrides: RunOverrides | undefined,
  execution: RunExecution,
): Promise<unknown | undefined> {
  const backendName = backend.id;
  const authoredConfig = cloneBackendConfig(agentConfig.backendConfig?.[backendName]);
  const overrideConfig = cloneBackendConfig(overrides?.backendConfig?.[backendName]);
  const sourcePath = backend.sourcePath ?? `<built-in:${backendName}>`;
  let resolved: unknown;
  try {
    resolved = backend.resolveConfig
      ? await backend.resolveConfig({
          backendName,
          authoredConfig,
          overrideConfig,
          env: process.env as Record<string, string>,
          execution,
        })
      : (authoredConfig ?? overrideConfig);
  } catch (error) {
    if (error instanceof BackendConfigError) {
      throw error;
    }
    throw new BackendConfigError(
      backendName,
      sourcePath,
      `  - resolveConfig threw: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (resolved !== undefined && !isJsonishPersistable(resolved)) {
    throw new BackendConfigError(
      backendName,
      sourcePath,
      "  - resolveConfig returned non-persistable data",
    );
  }
  return cloneBackendConfig(resolved);
}

function resolveFreshBackendArgs(
  backendId: BackendName,
  agentConfig: LoadedAgent["config"],
): ResolvedBackendArgs {
  if (backendId === "passive") {
    return [];
  }
  return cloneResolvedBackendArgs(agentConfig.backendArgs?.[backendId]?.extraArgs ?? []);
}

async function validateBootstrapBackendSessionId(
  sessionId: string,
  backend: Backend,
  cwd: string,
  backendConfig: unknown,
  resolvedBackendArgs: ResolvedBackendArgs,
): Promise<void> {
  if (backend.supportsBootstrapSessionImport === false) {
    throw new InvalidBackendSessionError(
      sessionId,
      `${backend.id} backend-session import is unsupported because public ${backend.id} resume ids are not safely self-validating`,
    );
  }

  if (!backend.validateSessionId) {
    return;
  }

  const result = await backend.validateSessionId({
    sessionId,
    cwd,
    env: process.env as Record<string, string>,
    backendConfig: cloneBackendConfig(backendConfig),
    resolvedBackendArgs: cloneResolvedBackendArgs(resolvedBackendArgs),
  });
  if (!result.valid) {
    throw new InvalidBackendSessionError(sessionId, result.reason);
  }
}

function resolveManifestBackendConfig(manifest: RunManifest): unknown | undefined {
  return cloneBackendConfig(manifest.backendConfig);
}

function emitCallerInstructions(
  callerInstructions: string | null,
  emitEvent: (event: RunEvent) => void,
): void {
  if (!callerInstructions || callerInstructions.length === 0) return;
  emitEvent({
    type: "caller_instructions",
    text: callerInstructions,
  });
}

function coerceVar(key: string, value: unknown, def: VarDef): unknown {
  switch (def.type) {
    case "string":
      if (typeof value !== "string") {
        throw new VarResolutionError(`var "${key}": expected string`);
      }
      return value;
    case "number": {
      if (typeof value === "number") {
        if (Number.isNaN(value)) {
          throw new VarResolutionError(`var "${key}": expected number, got NaN`);
        }
        return value;
      }
      if (typeof value !== "string") {
        throw new VarResolutionError(`var "${key}": expected number`);
      }
      const n = Number(value);
      if (Number.isNaN(n)) {
        throw new VarResolutionError(`var "${key}": expected number, got "${value}"`);
      }
      return n;
    }
    case "boolean":
      if (typeof value === "boolean") {
        return value;
      }
      if (typeof value !== "string") {
        throw new VarResolutionError(`var "${key}": expected boolean`);
      }
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      throw new VarResolutionError(`var "${key}": expected boolean, got "${value}"`);
    case "enum":
      if (typeof value !== "string") {
        throw new VarResolutionError(
          `var "${key}": expected one of ${def.values?.join(", ") ?? ""}`,
        );
      }
      if (!def.values?.includes(value)) {
        throw new VarResolutionError(
          `var "${key}": expected one of ${def.values?.join(", ") ?? ""}, got "${value}"`,
        );
      }
      return value;
    default:
      return value;
  }
}

const INTERPOLATION_TOKEN_PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/;

interface ResolvedVarsResult {
  values: Record<string, unknown>;
  sources: Record<string, RuntimeVarSourceRecord>;
}

function assertKnownCliVars(
  varsSchema: Record<string, VarDef>,
  cliVars: Record<string, string>,
): void {
  const declared = new Set(Object.keys(varsSchema));
  const unknown = Object.keys(cliVars).filter((key) => !declared.has(key));
  if (unknown.length === 0) return;
  throw new VarResolutionError(
    `unknown --var key(s): ${unknown.join(", ")}. Declare them under assignment.vars or remove the extra --var flag(s).`,
  );
}

function assertKnownWebVars(
  varsSchema: Record<string, VarDef>,
  webVars: Record<string, string>,
): void {
  const declared = new Set(Object.keys(varsSchema));
  const unknown = Object.keys(webVars).filter((key) => !declared.has(key));
  if (unknown.length === 0) return;
  throw new VarResolutionError(
    `unknown web var key(s): ${unknown.join(", ")}. Declare them under assignment.vars or remove the extra web field(s).`,
  );
}

export class LineageResolutionError extends VarResolutionError {
  constructor(message: string) {
    super(message);
    this.name = "LineageResolutionError";
  }
}

export class LineageMissingError extends VarResolutionError {
  constructor(message: string) {
    super(message);
    this.name = "LineageMissingError";
  }
}

interface LineageManifest {
  manifest: RunManifest;
}

function isLegacyRedactedRuntimeVar(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  if (record.redacted !== true || typeof record.source !== "string") {
    return false;
  }
  if (record.envName !== undefined && typeof record.envName !== "string") {
    return false;
  }
  if (record.inheritedFromRunId !== undefined && typeof record.inheritedFromRunId !== "string") {
    return false;
  }
  const allowedKeys = new Set(["redacted", "source", "envName", "inheritedFromRunId"]);
  return Object.keys(record).every((key) => allowedKeys.has(key));
}

function resolveLineageManifest(runId: string): LineageManifest {
  const matches = findRunManifestsById(runId);
  if (matches.length === 0) {
    throw new LineageResolutionError(`lineage parent run "${runId}" was not found`);
  }
  if (matches.length > 1) {
    throw new LineageResolutionError(
      `lineage parent run "${runId}" is ambiguous across multiple run buckets`,
    );
  }
  const [match] = matches;
  if (!match) {
    throw new LineageResolutionError(`lineage parent run "${runId}" could not be resolved`);
  }
  return { manifest: match.manifest };
}

function resolveLineageChain(parentRunId: string | null): LineageManifest[] {
  if (parentRunId === null) {
    return [];
  }
  const chain: LineageManifest[] = [];
  const seen = new Set<string>();
  let currentRunId: string | null = parentRunId;
  while (currentRunId !== null) {
    if (seen.has(currentRunId)) {
      throw new LineageResolutionError(`lineage cycle detected at parent run "${currentRunId}"`);
    }
    seen.add(currentRunId);
    const current = resolveLineageManifest(currentRunId);
    chain.push(current);
    currentRunId = current.manifest.parentRunId;
  }
  return chain;
}

function resolveFromParentLineage(
  key: string,
  lineageChain: LineageManifest[],
): { value: unknown; source: RuntimeVarSourceRecord } | null {
  for (const ancestor of lineageChain) {
    const value = ancestor.manifest.runtimeVars[key];
    if (value === undefined) {
      continue;
    }
    const inheritedSource = ancestor.manifest.runtimeVarSources[key];
    if (inheritedSource === undefined && isLegacyRedactedRuntimeVar(value)) {
      continue;
    }
    return {
      value,
      source: {
        source: "parent",
        inheritedFromRunId: ancestor.manifest.runId,
        envName: inheritedSource?.envName,
        redacted: inheritedSource?.redacted,
      },
    };
  }
  return null;
}

function resolveVars(
  varsSchema: Record<string, VarDef>,
  cliVars: Record<string, string>,
  webVars: Record<string, string>,
  lineageChain: LineageManifest[],
): ResolvedVarsResult {
  const values: Record<string, unknown> = {};
  const sources: Record<string, RuntimeVarSourceRecord> = {};
  for (const [key, def] of Object.entries(varsSchema)) {
    let value: unknown;
    let source: RuntimeVarSourceRecord | undefined;

    for (const authoredSource of def.sources) {
      if (authoredSource === "cli") {
        if (cliVars[key] !== undefined) {
          value = cliVars[key];
          source = { source: "cli" };
          break;
        }
        continue;
      }
      if (authoredSource === "web") {
        if (webVars[key] !== undefined) {
          value = webVars[key];
          source = { source: "web" };
          break;
        }
        continue;
      }
      if (authoredSource === "env") {
        const envName = def.envName ?? key;
        const envValue = process.env[envName];
        if (envValue !== undefined) {
          value = envValue;
          source = { source: "env", envName, redacted: true };
          break;
        }
        continue;
      }
      const inherited = resolveFromParentLineage(key, lineageChain);
      if (inherited !== null) {
        value = inherited.value;
        source = inherited.source;
        break;
      }
    }
    if (value === undefined && def.default !== undefined) {
      value = def.default;
      source = { source: "default" };
    }
    if (value === undefined) {
      continue;
    }

    values[key] = coerceVar(key, value, def);
    if (source) {
      sources[key] = source;
    }
  }
  return { values, sources };
}

function validateRequiredVars(
  varsSchema: Record<string, VarDef>,
  values: Record<string, unknown>,
  requiredAt: "initial" | "prepare",
): void {
  for (const [key, def] of Object.entries(varsSchema)) {
    if (!def.required || def.requiredAt !== requiredAt) {
      continue;
    }
    if (values[key] === undefined) {
      throw new LineageMissingError(`missing required ${requiredAt} var: ${key}`);
    }
  }
}

function buildInjectedVars(params: {
  runtimeVars: Record<string, unknown>;
  runId: string;
  runGroupId: string;
  cwd: string;
  assignmentName: string | undefined;
}): Record<string, unknown> {
  return {
    ...params.runtimeVars,
    run_id: params.runId,
    run_group_id: params.runGroupId,
    cwd: params.cwd,
    config_dir: resolveTaskRunnerConfigDir(),
    state_dir: resolveTaskRunnerStateDir(),
    task_runner_cmd: resolveTaskRunnerCommand(),
    ...(params.assignmentName !== undefined ? { assignment_name: params.assignmentName } : {}),
  };
}

function buildBackendInvokeEnv(params: {
  recursionState: RecursionState;
  runId: string;
  runGroupId: string;
  cwd: string;
}): Record<string, string> {
  return {
    ...(process.env as Record<string, string>),
    ...buildChildRecursionEnv(params.recursionState, params.runId, params.runGroupId),
    [TASK_RUNNER_RUN_ID_ENV]: params.runId,
    [TASK_RUNNER_CWD_ENV]: params.cwd,
  };
}

function resolveConfiguredCwd(
  input: string | undefined,
  fallback: string,
  injectedVars: Record<string, unknown>,
): string {
  if (!input || input === ".") return fallback;
  const interpolated = interpolate(input, injectedVars);
  const unresolvedToken = interpolated.match(INTERPOLATION_TOKEN_PATTERN)?.[0];
  if (unresolvedToken) {
    throw new VarResolutionError(`cwd interpolation could not resolve token ${unresolvedToken}`);
  }
  return isAbsolute(interpolated) ? interpolated : resolve(fallback, interpolated);
}

function syncFreshTasksToFinalInjectedVars(
  assignment: LoadedAssignment | undefined,
  currentTasks: Map<string, TaskState>,
  initialInjectedVars: Record<string, unknown>,
  finalInjectedVars: Record<string, unknown>,
): Map<string, TaskState> {
  if (!assignment) {
    return currentTasks;
  }
  const synced = new Map<string, TaskState>();
  for (const authoredTask of assignment.config.tasks) {
    const existing = currentTasks.get(authoredTask.id);
    if (!existing) {
      synced.set(authoredTask.id, {
        id: authoredTask.id,
        title: interpolate(authoredTask.title, finalInjectedVars),
        body: interpolate(authoredTask.body ?? "", finalInjectedVars),
        status: "pending",
        notes: "",
      });
      continue;
    }
    const initialTitle = interpolate(authoredTask.title, initialInjectedVars);
    const initialBody = interpolate(authoredTask.body ?? "", initialInjectedVars);
    synced.set(authoredTask.id, {
      ...existing,
      title:
        existing.title === initialTitle
          ? interpolate(authoredTask.title, finalInjectedVars)
          : existing.title,
      body:
        existing.body === initialBody
          ? interpolate(authoredTask.body ?? "", finalInjectedVars)
          : existing.body,
    });
  }
  for (const [taskId, task] of currentTasks) {
    if (!synced.has(taskId)) {
      synced.set(taskId, { ...task });
    }
  }
  return synced;
}

function resolveRuntimeBackend(backendId: string, fallback: Backend): Backend {
  if (backendId === fallback.id) {
    return fallback;
  }
  return resolveBackend(backendId);
}

function defaultResumeFailureDetector(result: BackendInvokeResult): boolean {
  if (result.exitCode === 0 || result.exitCode === null) return false;
  const stderr = result.rawStderr.toLowerCase();
  return (
    stderr.includes("session not found") ||
    stderr.includes("no such session") ||
    stderr.includes("could not find session") ||
    stderr.includes("unknown session")
  );
}

function buildFreshInitialPrompt(
  agentInstructions: string,
  assignmentInstructions: string,
  hasTasks: boolean,
  message: string,
  injectedVars: Record<string, unknown>,
): string {
  const parts: string[] = [];
  if (agentInstructions.length > 0) {
    parts.push(interpolate(agentInstructions, injectedVars));
  }
  if (assignmentInstructions.length > 0) {
    parts.push(interpolate(assignmentInstructions, injectedVars));
  }
  if (hasTasks) {
    parts.push(interpolate(WORKER_BRIEF_TEMPLATE, injectedVars));
  }
  if (message.length > 0) {
    parts.push(message);
  }
  if (parts.length === 0) {
    throw new EmptyPromptError();
  }
  return parts.join("\n\n");
}

function countBy(tasks: Map<string, TaskState>, predicate: (t: TaskState) => boolean): number {
  let n = 0;
  for (const task of tasks.values()) {
    if (predicate(task)) n++;
  }
  return n;
}

function formatUnhandledAttemptError(error: unknown): string {
  if (error instanceof Error) {
    if (typeof error.stack === "string" && error.stack.length > 0) {
      return error.stack;
    }
    return error.message;
  }
  return String(error);
}

function normalizeResumeStatus(status: TaskStatus): TaskStatus {
  return status === "in_progress" ? "pending" : status;
}

function normalizeTerminalTaskStatus(status: TaskStatus): TaskStatus {
  return status === "in_progress" ? "pending" : status;
}

function normalizeInactiveNonPassiveTasks(
  backendId: string,
  tasks: Map<string, TaskState>,
): Map<string, TaskState> {
  if (backendId === "passive") {
    return tasks;
  }
  for (const task of tasks.values()) {
    task.status = normalizeTerminalTaskStatus(task.status);
  }
  return tasks;
}

function rebuildTasksFromAssignmentAndSnapshot(
  assignment: LoadedAssignment | undefined,
  snapshot: Record<string, TaskSnapshot>,
  normalize: boolean,
  injectedVars?: Record<string, unknown>,
): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  const source = assignment?.config.tasks ?? [];
  for (const t of source) {
    const prior = snapshot[t.id];
    // Interpolate `{{var}}` references inside the fresh-run task
    // title and body against the same injectedVars used elsewhere.
    // On resume paths we skip this: the assignment isn't loaded and
    // the snapshot already carries interpolated text from its
    // original fresh-run build.
    const title = injectedVars ? interpolate(t.title, injectedVars) : t.title;
    const body = injectedVars ? interpolate(t.body ?? "", injectedVars) : (t.body ?? "");
    tasks.set(t.id, {
      id: t.id,
      title,
      body,
      status: prior ? (normalize ? normalizeResumeStatus(prior.status) : prior.status) : "pending",
      notes: prior?.notes ?? "",
    });
  }
  // Tasks that existed in the prior run but not in any current assignment
  // (e.g. chat mode with --add-task on the prior run) still come forward.
  for (const [id, snap] of Object.entries(snapshot)) {
    if (tasks.has(id)) continue;
    tasks.set(id, {
      id,
      title: snap.title,
      body: snap.body,
      status: normalize ? normalizeResumeStatus(snap.status) : snap.status,
      notes: snap.notes,
    });
  }
  return tasks;
}

function collectNewTasks(
  tasks: Map<string, TaskState>,
  snapshot: Record<string, TaskSnapshot>,
): TaskState[] {
  const added: TaskState[] = [];
  for (const task of tasks.values()) {
    if (!snapshot[task.id]) {
      added.push({ ...task });
    }
  }
  return added;
}

export async function runAgent(opts: RunOptions): Promise<RunOutcome> {
  const cliVars = opts.cliVars;
  const webVars = opts.webVars ?? {};
  const { loaded, loadedAssignment, backend, overrides, resume } = opts;
  const emitEvent = opts.emitEvent ?? (() => {});
  const emitAuditEnvelope = opts.emitAuditEnvelope ?? (() => {});
  const execution: RunExecution = opts.execution ?? {
    hostMode: "embedded",
    controller: {
      kind: "embedded",
    },
  };
  const agentConfig = loaded.config;
  const assignmentConfig = loadedAssignment?.config;
  const resumeFailureDetector = opts.resumeFailureDetector ?? defaultResumeFailureDetector;

  // Refuse to start if this invocation is nested too deep inside other
  // task-runner runs. Read the depth from our own env (set by a parent
  // task-runner via `buildChildRecursionEnv` below); the check fires
  // before any workspace creation or backend invocation so a runaway
  // recursive chain dies cheaply.
  const recursionState = readRecursionState();
  checkRecursionDepth(recursionState);

  const isInitialize = opts.initialize === true;
  const isReinitialize = isInitialize && Boolean(resume);
  const priorReady =
    !isInitialize && resume?.manifest.status === "ready" && resume.manifest.sessions.length === 0;
  const isResume = Boolean(resume) && !isReinitialize && !priorReady;

  if (resume && resume.manifest.archivedAt !== null) {
    if (isReinitialize) {
      throw new ResumeError(`cannot reinitialize archived run ${resume.manifest.runId}`);
    }
    throw new ResumeError(
      `cannot resume archived run ${resume.manifest.runId} — unarchive it first with ${resolveTaskRunnerCommand()} run unarchive ${resume.manifest.runId}`,
    );
  }
  if (isReinitialize && resume && resume.manifest.status !== "initialized") {
    throw new ResumeError(
      `cannot reinitialize run ${resume.manifest.runId} unless it is initialized`,
    );
  }
  if (!isInitialize && resume?.manifest.status === "initialized") {
    throw new ResumeError(
      `cannot execute initialized run ${resume.manifest.runId} — promote it first with ${resolveTaskRunnerCommand()} run ready ${resume.manifest.runId}`,
    );
  }
  if (resume && !priorReady && resume.manifest.status === "running") {
    throw new ResumeError(`cannot resume run ${resume.manifest.runId} — it is already running`);
  }

  // Resume override policy. The CLI also enforces most of these
  // earlier (with flag-level error messages), but these checks are
  // defense in depth for programmatic callers that construct
  // `RunOptions` directly — they bypass the CLI entirely and would
  // otherwise be able to violate the manifest-canonical contract.
  // Mirrors the policy matrix documented in docs/design.md under
  // "--resume-run".
  if (isResume || priorReady) {
    // Fields that are never valid on any resume (regular or
    // ready-start), regardless of prior status.
    if (loadedAssignment) {
      throw new ResumeError(
        priorReady
          ? "--assignment cannot be combined with starting a ready run"
          : "--assignment cannot be combined with --resume-run",
      );
    }
    if (opts.bootstrapBackendSessionId !== undefined) {
      throw new ResumeError("--backend-session-id cannot be combined with --resume-run");
    }
    if (opts.parentRunId !== undefined && opts.parentRunId !== null) {
      throw new ResumeError("--parent-run cannot be combined with --resume-run");
    }
    if (opts.runGroupId !== undefined && opts.runGroupId !== null) {
      throw new ResumeError("--group-id cannot be combined with --resume-run");
    }
    if (overrides?.cwd !== undefined) {
      throw new ResumeError(
        "--cwd cannot be combined with --resume-run — backend sessions are bound to the cwd they were created in, so a different cwd would invalidate the captured session id. Create a fresh run if you need a different cwd.",
      );
    }
    if (overrides?.backend !== undefined) {
      throw new ResumeError(
        "--backend cannot be combined with --resume-run (backend is locked to the run that created the session)",
      );
    }
    if (overrides?.launcher !== undefined) {
      throw new ResumeError("--launcher cannot be combined with --resume-run");
    }
    if (Object.keys(cliVars).length > 0 || Object.keys(webVars).length > 0) {
      throw new ResumeError(
        "--var and web-authored runtime vars cannot be combined with --resume-run — runtime vars are resolved from the assignment once at first write and frozen into the manifest; they are not re-resolved on resume.",
      );
    }
    if (overrides?.name !== undefined) {
      throw new ResumeError("--name cannot be combined with --resume-run");
    }

    // Starting a ready run is stricter: no overrides at all. Init
    // deliberately froze every resolvable field at creation time,
    // and the only valid invocation is `run --resume-run <id>`.
    if (priorReady) {
      const forbidden: string[] = [];
      if (overrides?.message && overrides.message.trim().length > 0) forbidden.push("message");
      if ((overrides?.addedTasks?.length ?? 0) > 0) forbidden.push("--add-task");
      if (overrides?.launcher !== undefined) forbidden.push("--launcher");
      if (overrides?.executionEnvironment !== undefined) forbidden.push("--environment");
      if (overrides?.model !== undefined) forbidden.push("--model");
      if (overrides?.effort !== undefined) forbidden.push("--effort");
      if (overrides?.timeoutSec !== undefined) forbidden.push("--timeout-sec");
      if (overrides?.maxRetries !== undefined) forbidden.push("--max-retries");
      if (overrides?.unrestricted !== undefined) forbidden.push("--unrestricted");
      if (overrides?.name !== undefined) forbidden.push("--name");
      if (overrides?.schedule !== undefined) forbidden.push("--schedule-*");
      if (forbidden.length > 0) {
        throw new ResumeError(
          `starting a ready run does not accept ${forbidden.join(", ")} — init froze these at creation. If you need different values, reinitialize the run first.`,
        );
      }
    }
  }

  const addedTitles = overrides?.addedTasks ?? [];
  const agentInstructions = loaded.instructions.trim();
  const assignmentInstructions = loadedAssignment?.instructions.trim() ?? "";

  // Locked-field enforcement. For fresh runs and regular resumes,
  // `checkLockedFields` vets every CLI override against the agent's
  // and assignment's lockedFields. For ready-start we run a
  // defensive second pass against the **frozen** `manifest.lockedFields`
  // union — the per-field override list above should already have
  // rejected everything, but if a future addition to RunOverrides
  // forgets to be added to that list, this catches the regression
  // instead of silently letting it through.
  if (!priorReady && !isResume) {
    checkLockedFields(
      agentConfig,
      assignmentConfig,
      agentInstructions,
      assignmentInstructions,
      overrides,
      addedTitles,
    );
  } else if (resume) {
    checkLockedFieldsFromManifest(resume.manifest, overrides, addedTitles);
  }

  const reusesFrozenSetup = (isResume || priorReady) && resume !== undefined;
  const parentRunId = reusesFrozenSetup
    ? (resume?.manifest.parentRunId ?? null)
    : (opts.parentRunId ?? readParentRunIdFromEnv() ?? null);
  const explicitRunGroupId =
    !reusesFrozenSetup && opts.runGroupId !== undefined && opts.runGroupId !== null
      ? validateRunGroupId(opts.runGroupId)
      : null;
  const envRunGroupId =
    !reusesFrozenSetup && explicitRunGroupId === null ? readRunGroupIdFromEnv() : null;
  let effectiveBackendName = backend.id;
  let currentBackend = backend;
  // When --backend overrides the agent's backend, the agent's `model`
  // is also dropped (since model strings are backend-specific). Pass
  // --model alongside --backend to set one for the new backend.
  const backendOverridden = overrides?.backend !== undefined;
  let model = overrides?.model ?? (backendOverridden ? undefined : agentConfig.model);
  let effort = overrides?.effort ?? agentConfig.effort;
  // Vars live on the assignment. Chat mode (no assignment) has no var
  // schema, so there is nothing to validate against or resolve from.
  const varsSchema = assignmentConfig?.vars ?? {};
  if (assignmentConfig) {
    assertKnownCliVars(varsSchema, cliVars);
    assertKnownWebVars(varsSchema, webVars);
  }
  const lineageChain = reusesFrozenSetup ? [] : resolveLineageChain(parentRunId);
  const resolvedVars = resolveVars(varsSchema, cliVars, webVars, lineageChain);
  let runtimeVars = reusesFrozenSetup
    ? { ...(resume?.manifest.runtimeVars ?? {}) }
    : resolvedVars.values;
  let runtimeVarSources = reusesFrozenSetup
    ? cloneRuntimeVarSources(resume?.manifest.runtimeVarSources ?? {})
    : cloneRuntimeVarSources(resolvedVars.sources);
  if (!reusesFrozenSetup) {
    validateRequiredVars(varsSchema, runtimeVars, "initial");
  }
  const reusingWorkspace = resume !== undefined;
  const runId = reusingWorkspace && resume ? resume.manifest.runId : shortId();
  let runGroupId =
    reusingWorkspace && resume
      ? resume.manifest.runGroupId
      : (explicitRunGroupId ??
        (envRunGroupId === null ? null : validateRunGroupId(envRunGroupId)) ??
        lineageChain[0]?.manifest.runGroupId ??
        runId);
  const assignmentName = loadedAssignment?.config.name ?? resume?.manifest.assignment?.name;
  let cwd = reusesFrozenSetup ? resume.manifest.cwd : (opts.callerCwd ?? process.cwd());
  let injectedVars = buildInjectedVars({
    runtimeVars,
    runId,
    runGroupId,
    cwd,
    assignmentName,
  });
  if (!reusesFrozenSetup) {
    cwd = resolveFreshRunCwd(loadedAssignment, overrides, opts.callerCwd, injectedVars);
    injectedVars = buildInjectedVars({
      runtimeVars,
      runId,
      runGroupId,
      cwd,
      assignmentName,
    });
  }
  let repo = reusesFrozenSetup ? resume.manifest.repo : deriveRepoKey(cwd);
  let backendConfig = reusesFrozenSetup
    ? resolveManifestBackendConfig(resume.manifest)
    : await resolveFreshBackendConfig(currentBackend, agentConfig, overrides, execution);
  let resolvedBackendArgs = reusesFrozenSetup
    ? cloneResolvedBackendArgs(resume.manifest.resolvedBackendArgs)
    : resolveFreshBackendArgs(effectiveBackendName, agentConfig);
  let launcher = reusesFrozenSetup
    ? cloneResolvedLauncherConfig(resume.manifest.launcher)
    : interpolateResolvedLauncher(
        resolveFreshLauncherConfig({
          backend: currentBackend,
          backendConfig,
          agentLauncher: loaded.launcher,
          overrideLauncher: overrides?.launcher,
          cwd,
        }),
        injectedVars,
      );
  let executionEnvironment = reusesFrozenSetup
    ? resume.manifest.executionEnvironment
    : resolveFreshExecutionEnvironment({
        reference: loaded.executionEnvironment,
        overrideEnvironment: overrides?.executionEnvironment,
        cwd,
        injectedVars,
        runId,
        runGroupId,
        backend: currentBackend.id,
      });
  if (executionEnvironment !== null && launcher.kind !== "direct") {
    throw new ResumeError(
      "execution environments cannot be combined with non-direct launchers; use one runtime wrapper mechanism per run",
    );
  }
  if (executionEnvironment !== null && !launcherAppliesToBackend(currentBackend, backendConfig)) {
    throw new ResumeError(
      `execution environments only apply to subprocess-backed backend invocations; backend ${currentBackend.id} is direct for this run`,
    );
  }
  const message = overrides?.message ?? assignmentConfig?.message ?? null;
  let timeoutSec = overrides?.timeoutSec ?? agentConfig.timeoutSec;
  let unrestricted = overrides?.unrestricted ?? agentConfig.unrestricted;
  // maxRetries lives on the assignment. In chat mode (no assignment
  // loaded), fall back to a hard default of 3 to match the assignment
  // schema's own default.
  const maxRetries = resolveFreshRunMaxRetries(overrides?.maxRetries, loadedAssignment);
  const maxAttemptsPerSession = maxRetries + 1;

  if (isResume) {
    const hasMessage = Boolean(message && message.trim().length > 0);
    const hasAddedTasks = addedTitles.length > 0;
    const canResumeImplicitly = hasRunnableTasks(resume?.manifest.finalTasks ?? {});
    if (!hasMessage && !hasAddedTasks && !canResumeImplicitly) {
      throw new ResumeError(missingResumeInputMessage());
    }
    if (!resume?.manifest.backendSessionId) {
      throw new ResumeError(
        `cannot resume run ${resume?.manifest.runId ?? "<unknown>"} — prior sessions captured no backend session id`,
      );
    }
  }

  const workspaceDir =
    reusingWorkspace && resume ? resume.workspaceDir : resolveRunWorkspaceDirForRepo(repo, runId);
  mkdirSync(workspaceDir, { recursive: true });
  const assignmentSeedPath = workspaceAssignmentPath(workspaceDir);
  const resolvedHookDescriptors =
    isResume || priorReady
      ? (resume?.manifest.resolvedHooks ?? [])
      : (opts.resolvedHooksOverride ?? resolveAssignmentHooks(loadedAssignment, injectedVars));
  const initialSchedule =
    !isResume && !priorReady
      ? (() => {
          const scheduleInput = overrides?.schedule ?? assignmentConfig?.schedule;
          return scheduleInput === undefined ? null : resolveScheduleInput(scheduleInput);
        })()
      : null;

  const priorHadTasks = Boolean(
    isResume && resume && Object.keys(resume.manifest.finalTasks).length > 0,
  );
  const overrideName = normalizeRunName(overrides?.name);
  let hookState = isResume || priorReady ? { ...(resume?.manifest.hookState ?? {}) } : {};
  let hookAttachments =
    isResume || priorReady
      ? (resume?.manifest.attachments.map((attachment) => ({ ...attachment })) ?? [])
      : [];
  let hookNote = isResume || priorReady ? (resume?.manifest.note ?? null) : null;
  let hookPinned = isResume || priorReady ? (resume?.manifest.pinned ?? false) : false;
  let hookLockedFields =
    isResume || priorReady
      ? resume?.manifest.lockedFields !== undefined
        ? [...resume.manifest.lockedFields]
        : null
      : null;

  let tasks: Map<string, TaskState>;
  if (isResume && resume) {
    tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, resume.manifest.finalTasks, true);
  } else if (priorReady && resume) {
    tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, resume.manifest.finalTasks, false);
  } else {
    tasks = rebuildTasksFromAssignmentAndSnapshot(loadedAssignment, {}, false, injectedVars);
  }

  for (let i = 0; i < addedTitles.length; i++) {
    const rawTitle = addedTitles[i];
    if (rawTitle === undefined) continue;
    validateAddedTaskTitle(rawTitle, i);
    const title = rawTitle.trim();
    let id: string;
    do {
      id = `cli-${shortId()}`;
    } while (tasks.has(id));
    tasks.set(id, {
      id,
      title,
      body: "",
      status: "pending",
      notes: "",
    });
  }

  const trimmedMessage = message?.trim() ?? "";
  const now = new Date().toISOString();

  if (!isResume && !priorReady) {
    const prePrepareInjectedVars = injectedVars;
    const defaultInitialPrompt = buildFreshInitialPrompt(
      agentInstructions,
      assignmentInstructions,
      tasks.size > 0,
      trimmedMessage,
      injectedVars,
    );
    const initialLockedFields = Array.from(
      new Set<LockableField>([
        ...agentConfig.lockedFields,
        ...(assignmentConfig?.lockedFields ?? []),
      ]),
    );
    const prepareManifest: RunManifest = {
      schemaVersion: 22,
      runId,
      repo,
      agent: {
        name: agentConfig.name,
        sourcePath: loaded.sourcePath,
        instructions:
          agentInstructions.length > 0 ? interpolate(agentInstructions, injectedVars) : "",
      },
      assignment: loadedAssignment
        ? {
            name: loadedAssignment.config.name,
            sourcePath: loadedAssignment.sourcePath,
          }
        : null,
      backend: effectiveBackendName,
      model: model ?? null,
      effort: effort ?? null,
      backendConfig: cloneBackendConfig(backendConfig),
      resolvedBackendArgs: cloneResolvedBackendArgs(resolvedBackendArgs),
      launcher: cloneResolvedLauncherConfig(launcher),
      message,
      name: overrideName,
      note: null,
      pinned: false,
      unrestricted,
      cwd,
      lockedFields: initialLockedFields,
      timeoutSec,
      workspaceDir,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      archivedAt: null,
      status: isInitialize ? "initialized" : "running",
      runGroupId,
      dependencies: [],
      parentRunId,
      schedule: initialSchedule,
      queuedResumeMessages: [],
      exitCode: null,
      totalAttemptCount: 0,
      maxAttemptsPerSession,
      tasksCompleted: 0,
      tasksTotal: tasks.size,
      backendSessionId: opts.bootstrapBackendSessionId ?? null,
      backendSessionSync: null,
      runtimeVars: { ...runtimeVars },
      runtimeVarSources: cloneRuntimeVarSources(runtimeVarSources),
      execution,
      executionEnvironment,
      brief: "",
      resolvedHooks: resolvedHookDescriptors.map((descriptor) => ({
        ...descriptor,
        source: { ...descriptor.source },
        when: descriptor.when ? { ...descriptor.when } : null,
      })),
      hookState: {},
      hookAudits: [],
      callerInstructions: null,
      resetSeed: buildRunResetSeed({
        backend: effectiveBackendName,
        model: model ?? null,
        effort: effort ?? null,
        backendConfig: cloneBackendConfig(backendConfig),
        resolvedBackendArgs,
        launcher: cloneResolvedLauncherConfig(launcher),
        executionEnvironment,
        cwd,
        lockedFields: initialLockedFields,
        message,
        name: overrideName,
        note: null,
        pinned: false,
        runGroupId,
        dependencies: [],
        parentRunId,
        unrestricted,
        timeoutSec,
        maxAttemptsPerSession,
        brief: "",
        runtimeVars: { ...runtimeVars },
        runtimeVarSources: cloneRuntimeVarSources(runtimeVarSources),
        hookState: {},
        attachments: [],
        finalTasks: snapshotTasks(tasks),
      }),
      attachments: [],
      finalTasks: snapshotTasks(tasks),
      totalSessionCount: 0,
      sessions: [],
      attemptRecords: [],
    };
    const prepareState = createHookExecutionState(
      prepareManifest,
      tasks,
      {
        initialPrompt: defaultInitialPrompt,
      },
      lifecycleRunEventContext(execution),
    );
    await runPrepareHooks(prepareState, defaultInitialPrompt, initialLockedFields);
    tasks = prepareState.tasks;
    cwd = prepareState.manifest.cwd;
    repo = deriveRepoKey(cwd);
    effectiveBackendName = prepareState.manifest.backend as BackendName;
    resolvedBackendArgs = resolveFreshBackendArgs(effectiveBackendName, agentConfig);
    prepareState.manifest.resolvedBackendArgs = cloneResolvedBackendArgs(resolvedBackendArgs);
    currentBackend = resolveRuntimeBackend(effectiveBackendName, backend);
    try {
      backendConfig = await resolveFreshBackendConfig(
        currentBackend,
        agentConfig,
        overrides,
        execution,
      );
    } catch (error) {
      rmSync(workspaceDir, { recursive: true, force: true });
      throw error;
    }
    prepareState.manifest.backendConfig = cloneBackendConfig(backendConfig);
    model = prepareState.manifest.model ?? undefined;
    effort = (prepareState.manifest.effort ?? undefined) as RunOverrides["effort"];
    timeoutSec = prepareState.manifest.timeoutSec;
    unrestricted = prepareState.manifest.unrestricted;
    runGroupId = prepareState.manifest.runGroupId;
    runtimeVars = { ...prepareState.manifest.runtimeVars };
    runtimeVarSources = cloneRuntimeVarSources(prepareState.manifest.runtimeVarSources);
    validateRequiredVars(varsSchema, runtimeVars, "prepare");
    injectedVars = buildInjectedVars({
      runtimeVars,
      runId,
      runGroupId,
      cwd,
      assignmentName,
    });
    launcher = interpolateResolvedLauncher(
      resolveFreshLauncherConfig({
        backend: currentBackend,
        backendConfig,
        agentLauncher: loaded.launcher,
        overrideLauncher: overrides?.launcher,
        cwd,
      }),
      injectedVars,
    );
    executionEnvironment = resolveFreshExecutionEnvironment({
      reference: loaded.executionEnvironment,
      overrideEnvironment: overrides?.executionEnvironment,
      cwd,
      injectedVars,
      runId,
      runGroupId,
      backend: currentBackend.id,
    });
    if (executionEnvironment !== null && launcher.kind !== "direct") {
      throw new ResumeError(
        "execution environments cannot be combined with non-direct launchers; use one runtime wrapper mechanism per run",
      );
    }
    if (executionEnvironment !== null && !launcherAppliesToBackend(currentBackend, backendConfig)) {
      throw new ResumeError(
        `execution environments only apply to subprocess-backed backend invocations; backend ${currentBackend.id} is direct for this run`,
      );
    }
    prepareState.manifest.launcher = cloneResolvedLauncherConfig(launcher);
    prepareState.manifest.executionEnvironment = executionEnvironment;
    hookState = { ...prepareState.manifest.hookState };
    hookAttachments = prepareState.manifest.attachments.map((attachment) => ({ ...attachment }));
    hookNote = prepareState.manifest.note;
    hookPinned = prepareState.manifest.pinned;
    hookLockedFields = [...prepareState.manifest.lockedFields];
    tasks = syncFreshTasksToFinalInjectedVars(
      loadedAssignment,
      tasks,
      prePrepareInjectedVars,
      injectedVars,
    );
  }

  // If the caller is importing an existing backend session, validate it
  // after prepare hooks so the check sees the same backend, cwd,
  // backendConfig, and backendArgs that the first invocation will use.
  if (opts.bootstrapBackendSessionId !== undefined) {
    await validateBootstrapBackendSessionId(
      opts.bootstrapBackendSessionId,
      currentBackend,
      cwd,
      backendConfig,
      resolvedBackendArgs,
    );
  }

  const hasTasks = tasks.size > 0;
  const firstTimeTasksAppear = isResume && !priorHadTasks && hasTasks;
  const resumeAddedNewTasks = isResume && priorHadTasks && addedTitles.length > 0;
  const resumeUsesImplicitContinueMessage =
    isResume &&
    trimmedMessage.length === 0 &&
    addedTitles.length === 0 &&
    hasRunnableTasks(resume?.manifest.finalTasks ?? {});

  // Run name resolution: fresh `run` / `init` may set it via the
  // CLI override, while resume and ready-start always reuse
  // the persisted manifest value.
  let name = overrideName ?? ((isResume || priorReady) && resume ? resume.manifest.name : null);

  // Worker handoff composition (Option B: broad → specific → mechanics → ask).
  //
  // Fresh run parts (non-empty only, joined with `\n\n`):
  //   1. agent instructions (role)
  //   2. assignment instructions (work context)
  //   3. task workflow (mechanics, if tasks exist)
  //   4. message (specific ask)
  //
  // Resume follow-up parts:
  //   1. workflow (only if firstTimeTasksAppear) OR new-tasks reminder
  //   2. message, or an implicit continue prompt when unfinished tasks remain
  //
  // Start-after-ready: reuse the stored brief verbatim.
  //
  // Both message-last. Fresh runs error if parts is empty.
  let initialPrompt: string;
  if (priorReady && resume) {
    const stored = resume.manifest.brief;
    if (stored.length === 0) {
      throw new ResumeError(
        `cannot start ready run ${resume.manifest.runId} — manifest has no brief`,
      );
    }
    initialPrompt = stored;
  } else if (isResume) {
    const parts: string[] = [];
    if (firstTimeTasksAppear) {
      parts.push(interpolate(WORKER_BRIEF_TEMPLATE, injectedVars));
    } else if (resumeAddedNewTasks) {
      parts.push(buildAddedTasksReminder(addedTitles.length, runId));
    }
    if (trimmedMessage.length > 0) {
      parts.push(trimmedMessage);
    } else if (resumeUsesImplicitContinueMessage) {
      parts.push(IMPLICIT_RESUME_MESSAGE);
    }
    initialPrompt = parts.join("\n\n");
  } else {
    initialPrompt = buildFreshInitialPrompt(
      agentInstructions,
      assignmentInstructions,
      hasTasks,
      trimmedMessage,
      injectedVars,
    );
  }

  let priorAttemptCount = isResume && resume ? resume.manifest.attemptRecords.length : 0;
  let priorSessionCount = isResume && resume ? resume.manifest.sessions.length : 0;
  // Ready-start runs begin at session 0 — init/ready created no session.
  let sessionIndex = priorReady ? 0 : priorSessionCount;

  let manifest: RunManifest;
  if (isResume && resume) {
    manifest = buildResumeSessionManifest(resume.manifest, initialPrompt, {
      model: model ?? null,
      effort: effort ?? null,
      launcher,
      name,
      unrestricted,
      cwd,
      timeoutSec,
      workspaceDir,
      maxAttemptsPerSession,
      execution,
      totalSessionCount: priorSessionCount + 1,
    });
  } else if (priorReady && resume) {
    // Start-after-ready: the manifest was persisted by `init`. Flip it
    // to "running", promote totalSessionCount to 1, and preserve the brief.
    manifest = {
      ...resume.manifest,
      brief: initialPrompt,
      name,
      endedAt: null,
      status: "running",
      exitCode: null,
      totalSessionCount: 1,
      execution,
    };
  } else {
    // Freeze the union of agent + assignment lockedFields into the
    // manifest at first write. Resume consults this union (the
    // assignment is forbidden on resume, so there's no other source
    // of lock info post-creation).
    const frozenLockedFields: LockableField[] = Array.from(
      new Set<LockableField>([
        ...agentConfig.lockedFields,
        ...(assignmentConfig?.lockedFields ?? []),
      ]),
    );
    // Freeze assignment.callerInstructions (if any) into the manifest
    // with {{var}} refs interpolated. This is documentation for the
    // CALLER of task-runner, not content sent to the backend — see
    // the field comment on RunManifest.callerInstructions.
    //
    // Trim before the length check: a whitespace-only value (like
    // `callerInstructions: "   "`) would otherwise freeze into the
    // manifest as whitespace and later render as an empty banner at
    // print time. Treat it as absent.
    const rawCallerInstructions = assignmentConfig?.callerInstructions?.trim() ?? "";
    const frozenCallerInstructions =
      rawCallerInstructions.length > 0 ? interpolate(rawCallerInstructions, injectedVars) : null;
    manifest = {
      schemaVersion: 22,
      runId,
      repo,
      agent: {
        name: agentConfig.name,
        sourcePath: loaded.sourcePath,
        // Role instructions with `{{var}}` references already
        // interpolated against `injectedVars`. Frozen here so resume
        // never re-reads the source file AND never needs to
        // re-interpolate (vars can't change on resume anyway).
        instructions:
          agentInstructions.length > 0 ? interpolate(agentInstructions, injectedVars) : "",
      },
      assignment: loadedAssignment
        ? {
            name: loadedAssignment.config.name,
            sourcePath: loadedAssignment.sourcePath,
          }
        : null,
      backend: effectiveBackendName,
      model: model ?? null,
      effort: effort ?? null,
      backendConfig: cloneBackendConfig(backendConfig),
      resolvedBackendArgs: cloneResolvedBackendArgs(resolvedBackendArgs),
      launcher: cloneResolvedLauncherConfig(launcher),
      message,
      name,
      note: hookNote,
      pinned: hookPinned,
      unrestricted,
      cwd,
      lockedFields: [...(hookLockedFields ?? frozenLockedFields)],
      timeoutSec,
      workspaceDir,
      startedAt: now,
      updatedAt: now,
      endedAt: null,
      archivedAt: null,
      status: isInitialize ? "initialized" : "running",
      runGroupId,
      dependencies: [],
      parentRunId,
      schedule: initialSchedule,
      queuedResumeMessages: [],
      exitCode: null,
      totalAttemptCount: 0,
      maxAttemptsPerSession,
      tasksCompleted: 0,
      tasksTotal: tasks.size,
      // If the caller imported an existing backend session, persist it
      // here at construction time. The first attempt's `sessionId`
      // local also seeds from this so the very first invocation does
      // a backend resume instead of starting a fresh session.
      backendSessionId: opts.bootstrapBackendSessionId ?? null,
      backendSessionSync: null,
      runtimeVars: { ...runtimeVars },
      runtimeVarSources: cloneRuntimeVarSources(runtimeVarSources),
      execution,
      executionEnvironment,
      brief: initialPrompt,
      resolvedHooks: resolvedHookDescriptors.map((descriptor) => ({
        ...descriptor,
        source: { ...descriptor.source },
        when: descriptor.when ? { ...descriptor.when } : null,
      })),
      hookState: { ...hookState },
      hookAudits: [],
      callerInstructions: frozenCallerInstructions,
      resetSeed: buildRunResetSeed({
        backend: effectiveBackendName,
        model: model ?? null,
        effort: effort ?? null,
        backendConfig: cloneBackendConfig(backendConfig),
        resolvedBackendArgs,
        launcher: cloneResolvedLauncherConfig(launcher),
        executionEnvironment,
        cwd,
        lockedFields: [...(hookLockedFields ?? frozenLockedFields)],
        message,
        name,
        note: hookNote,
        pinned: hookPinned,
        runGroupId,
        dependencies: [],
        parentRunId,
        unrestricted,
        timeoutSec,
        maxAttemptsPerSession,
        brief: initialPrompt,
        runtimeVars: { ...runtimeVars },
        runtimeVarSources: cloneRuntimeVarSources(runtimeVarSources),
        hookState: { ...hookState },
        attachments: hookAttachments.map((attachment) => ({ ...attachment })),
        finalTasks: snapshotTasks(tasks),
      }),
      attachments: hookAttachments.map((attachment) => ({ ...attachment })),
      finalTasks: {},
      totalSessionCount: 0,
      sessions: [],
      attemptRecords: [],
    };
  }

  if (isInitialize && opts.stageInitialize === true) {
    syncManifestTaskState(manifest, tasks);
    return {
      summary: {
        status: "initialized",
        sessionAttemptCount: 0,
        maxAttemptsPerSession,
        totalAttemptCount: manifest.attemptRecords.length,
        totalSessionCount: manifest.sessions.length,
        tasksCompleted: 0,
        tasksTotal: tasks.size,
        tasks: Array.from(tasks.values()),
        runId,
      },
      exitCode: 0,
      attemptTranscripts: [],
      runId,
      workspaceDir,
      manifest,
    };
  }

  if (isReinitialize) {
    rmSync(`${workspaceDir}/attempts`, { recursive: true, force: true });
    rmSync(`${workspaceDir}/attachments`, { recursive: true, force: true });
  }

  if ((resume === undefined || isReinitialize) && loadedAssignment?.sourcePath) {
    if (loadedAssignment.sourcePath !== assignmentSeedPath) {
      copyFileSync(loadedAssignment.sourcePath, assignmentSeedPath);
    }
  } else if (isReinitialize) {
    rmSync(assignmentSeedPath, { force: true });
  }

  if ((resume === undefined || isReinitialize) && loaded.sourcePath) {
    if (loaded.sourcePath !== workspaceAgentPath(workspaceDir)) {
      copyFileSync(loaded.sourcePath, workspaceAgentPath(workspaceDir));
    }
  } else if (isReinitialize) {
    rmSync(workspaceAgentPath(workspaceDir), { force: true });
  }

  const lifecycleContext = lifecycleRunEventContext(execution);
  const appendRunCreatedAudit = (targetManifest: RunManifest): void => {
    emitAuditEnvelope(
      appendRunCreatedEvent({
        manifest: targetManifest,
        context: lifecycleContext,
        agentName: agentConfig.name,
        assignmentName: loadedAssignment?.config.name ?? null,
        passive: agentConfig.backend === "passive",
      }),
    );
    if (targetManifest.backendSessionId !== null) {
      emitAuditEnvelope(
        appendRunBackendSessionUpdatedEvent({
          manifest: targetManifest,
          context: lifecycleContext,
          previousBackendSessionId: null,
          nextBackendSessionId: targetManifest.backendSessionId,
          reason: "bootstrap_import",
        }),
      );
    }
  };

  const appendBackendHistoryAudit = (
    targetManifest: RunManifest,
    reason: "bootstrap" | "pre_resume",
    result: BackendSessionHistorySyncResult,
  ): void => {
    if (result.status !== "synced") {
      return;
    }
    const appendEvent =
      reason === "bootstrap"
        ? appendRunBackendSessionHistoryImportedEvent
        : appendRunBackendSessionHistorySyncedEvent;
    emitAuditEnvelope(
      appendEvent({
        manifest: targetManifest,
        context: lifecycleContext,
        reason,
        importedTurnCount: result.importedTurnCount,
        openTurnCount: result.openTurnCount,
        addedAttemptNumbers: result.addedAttemptNumbers,
      }),
    );
  };
  const backendSessionSyncStateKey = (targetManifest: RunManifest): string =>
    JSON.stringify(targetManifest.backendSessionSync);
  const assertResumeAllowed = (targetManifest: RunManifest): void => {
    if (targetManifest.archivedAt !== null) {
      throw new ResumeError(
        `cannot resume archived run ${targetManifest.runId} — unarchive it first with ${resolveTaskRunnerCommand()} run unarchive ${targetManifest.runId}`,
      );
    }
    if (targetManifest.status === "running") {
      throw new ResumeError(`cannot resume run ${targetManifest.runId} — it is already running`);
    }
  };
  const recordPreResumeBackendHistorySyncFailure = async (error: unknown): Promise<void> => {
    await withTaskStateLockAsync(workspaceDir, async () => {
      const latest = resolveResumeTarget(workspaceDir).manifest;
      if (recordBackendSessionSyncError(latest, (error as Error).message)) {
        writeManifest(workspaceDir, latest);
      }
      appendBackendHistorySyncFailedAudit(latest, "pre_resume", error);
    });
  };

  const appendBackendHistorySyncFailedAudit = (
    targetManifest: RunManifest,
    reason: "bootstrap" | "pre_resume",
    error: unknown,
  ): void => {
    emitAuditEnvelope(
      appendRunBackendSessionHistorySyncFailedEvent({
        manifest: targetManifest,
        context: lifecycleContext,
        reason,
        error: error instanceof Error ? error.message : String(error),
      }),
    );
  };

  if (!isResume && opts.bootstrapBackendSessionId !== undefined) {
    try {
      const importResult = await importBackendSessionHistoryForInitialManifest({
        manifest,
        backend: currentBackend,
      });
      appendBackendHistoryAudit(manifest, "bootstrap", importResult);
    } catch (error) {
      appendBackendHistorySyncFailedAudit(manifest, "bootstrap", error);
      throw new InvalidBackendSessionError(
        opts.bootstrapBackendSessionId,
        (error as Error).message,
      );
    }
    priorAttemptCount = manifest.attemptRecords.length;
    priorSessionCount = manifest.sessions.length;
    sessionIndex = priorReady ? 0 : priorSessionCount;
  }

  // `init` stops here: persist the prepared workspace + manifest and
  // return a terminal "initialized" outcome. No session is created; the
  // caller will follow up with `task-runner run --resume-run <id>` —
  // or, for passive agents, with `task-runner task set` / `task add`.
  if (isInitialize) {
    syncManifestTaskState(manifest, tasks);
    writeManifest(workspaceDir, manifest);
    const isPassive = agentConfig.backend === "passive";
    if (!isReinitialize) {
      withTaskStateLock(workspaceDir, () => {
        appendRunCreatedAudit(manifest);
      });
    }
    emitEvent({
      type: "run_initialized",
      runId,
      agentName: agentConfig.name,
      assignmentSourcePath: loadedAssignment?.sourcePath ?? null,
      name,
      cwd,
      passive: isPassive,
      brief: initialPrompt,
    });
    emitCallerInstructions(manifest.callerInstructions, emitEvent);
    return {
      summary: {
        status: "initialized",
        sessionAttemptCount: 0,
        maxAttemptsPerSession,
        totalAttemptCount: manifest.attemptRecords.length,
        totalSessionCount: manifest.sessions.length,
        tasksCompleted: 0,
        tasksTotal: tasks.size,
        tasks: Array.from(tasks.values()),
        runId,
      },
      exitCode: 0,
      attemptTranscripts: [],
      runId,
      workspaceDir,
      manifest,
    };
  }

  if (manifest.executionEnvironment !== null) {
    let preparedEnvironment: RunManifest["executionEnvironment"];
    const previousEnvironment = manifest.executionEnvironment;
    try {
      preparedEnvironment = await prepareExecutionEnvironment(manifest.executionEnvironment);
    } catch (error) {
      emitAuditEnvelope(
        appendRunEnvironmentValidationFailedEvent({
          manifest,
          context: lifecycleContext,
          error,
        }),
      );
      throw error;
    }
    manifest.executionEnvironment = preparedEnvironment;
    if (reusingWorkspace) {
      await withTaskStateLockAsync(workspaceDir, async () => {
        const latest = resolveResumeTarget(workspaceDir).manifest;
        latest.executionEnvironment = preparedEnvironment;
        writeManifest(workspaceDir, latest);
      });
    }
    emitAuditEnvelope(
      appendRunEnvironmentValidatedEvent({
        manifest,
        context: lifecycleContext,
      }),
    );
    if (
      previousEnvironment.mode === "managed" &&
      previousEnvironment.containerId === null &&
      preparedEnvironment?.mode === "managed" &&
      preparedEnvironment.containerId !== null
    ) {
      emitAuditEnvelope(
        appendRunContainerCreatedEvent({
          manifest,
          context: lifecycleContext,
        }),
      );
    }
  }

  const addedTasks =
    reusingWorkspace && resume && !priorReady
      ? collectNewTasks(tasks, resume.manifest.finalTasks)
      : [];
  let sessionRecord: SessionRecord;
  if (reusingWorkspace) {
    for (let prepareAttempt = 0; ; prepareAttempt++) {
      let syncSnapshot: RunManifest | null = null;
      let syncStateKey: string | null = null;
      await withTaskStateLockAsync(workspaceDir, async () => {
        const latest = resolveResumeTarget(workspaceDir).manifest;
        assertResumeAllowed(latest);
        if (latest.backendSessionId !== null) {
          syncSnapshot = structuredClone(latest);
          syncStateKey = backendSessionSyncStateKey(latest);
        }
      });

      let syncPreparation: BackendSessionHistorySyncPreparation | null = null;
      if (syncSnapshot !== null) {
        try {
          syncPreparation = await prepareBackendSessionHistorySync({
            manifest: syncSnapshot,
            backend: currentBackend,
            mode: "sync",
          });
        } catch (error) {
          await recordPreResumeBackendHistorySyncFailure(error);
          throw new ResumeError(
            `cannot sync backend session history before resume: ${(error as Error).message}`,
          );
        }
      }

      const finalized = await withTaskStateLockAsync(workspaceDir, async () => {
        let latest = resolveResumeTarget(workspaceDir).manifest;
        assertResumeAllowed(latest);

        if (latest.backendSessionId !== null) {
          if (
            syncSnapshot === null ||
            syncPreparation === null ||
            latest.backend !== syncSnapshot.backend ||
            latest.backendSessionId !== syncSnapshot.backendSessionId ||
            backendSessionSyncStateKey(latest) !== syncStateKey
          ) {
            return false;
          }

          if (
            syncPreparation.status === "skipped" &&
            syncPreparation.reason === "source_unavailable"
          ) {
            const error = new ResumeError("backend session history source is unavailable");
            if (recordBackendSessionSyncError(latest, error.message)) {
              writeManifest(workspaceDir, latest);
            }
            appendBackendHistorySyncFailedAudit(latest, "pre_resume", error);
            throw error;
          }

          if (syncPreparation.status === "ready") {
            let syncResult: BackendSessionHistorySyncResult;
            try {
              syncResult = applyPreparedBackendSessionHistorySync({
                backend: currentBackend,
                manifest: latest,
                mode: "sync",
                prepared: syncPreparation,
              });
            } catch (error) {
              if (recordBackendSessionSyncError(latest, (error as Error).message)) {
                writeManifest(workspaceDir, latest);
              }
              appendBackendHistorySyncFailedAudit(latest, "pre_resume", error);
              throw new ResumeError(
                `cannot sync backend session history before resume: ${(error as Error).message}`,
              );
            }
            if (syncResult.status === "synced") {
              writeManifest(workspaceDir, latest);
              appendBackendHistoryAudit(latest, "pre_resume", syncResult);
              latest = resolveResumeTarget(workspaceDir).manifest;
            }
          }
        }

        priorAttemptCount = latest.attemptRecords.length;
        priorSessionCount = latest.sessions.length;
        sessionIndex = priorReady ? 0 : priorSessionCount;
        tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, latest.finalTasks, isResume);
        for (const task of addedTasks) {
          tasks.set(task.id, { ...task });
        }

        if (isResume) {
          manifest = buildResumeSessionManifest(latest, initialPrompt, {
            model: model ?? null,
            effort: effort ?? null,
            launcher,
            name,
            unrestricted,
            cwd,
            timeoutSec,
            workspaceDir,
            maxAttemptsPerSession,
            execution,
            totalSessionCount: priorSessionCount + 1,
          });
        } else {
          manifest = {
            ...latest,
            brief: initialPrompt,
            name,
            endedAt: null,
            status: "running",
            exitCode: null,
            totalSessionCount: 1,
            execution,
          };
        }

        consumeOneTimeScheduleForManualStart(manifest, lifecycleContext, emitAuditEnvelope);
        syncManifestTaskState(manifest, tasks);
        refreshManifestAttachments(manifest);
        sessionRecord = {
          sessionIndex,
          startedAt: now,
          endedAt: null,
          status: "running",
          exitCode: null,
          message: priorReady ? latest.message : message,
          brief: initialPrompt,
          firstAttemptNumber: null,
          lastAttemptNumber: null,
          maxAttemptsPerSession,
          backendSessionIdAtStart: latest.backendSessionId,
          backendSessionIdAtEnd: null,
          provenance: { kind: "task_runner" },
        };
        manifest.sessions.push(sessionRecord);
        manifest.totalAttemptCount = manifest.attemptRecords.length;
        manifest.totalSessionCount = manifest.sessions.length;
        writeManifest(workspaceDir, manifest);
        emitAuditEnvelope(
          appendRunStartedEvent({
            manifest,
            context: lifecycleContext,
            sessionIndex,
            backendSessionIdAtStart: sessionRecord.backendSessionIdAtStart,
            resumed: priorSessionCount > 0,
          }),
        );
        return true;
      });
      if (finalized) {
        break;
      }
      if (prepareAttempt > 0) {
        throw new ResumeError(
          "backend session history changed while preparing resume; retry the resume request",
        );
      }
    }
  } else {
    consumeOneTimeScheduleForManualStart(manifest, lifecycleContext, emitAuditEnvelope);
    syncManifestTaskState(manifest, tasks);
    sessionRecord = {
      sessionIndex,
      startedAt: now,
      endedAt: null,
      status: "running",
      exitCode: null,
      message: message,
      brief: initialPrompt,
      firstAttemptNumber: null,
      lastAttemptNumber: null,
      maxAttemptsPerSession,
      backendSessionIdAtStart: opts.bootstrapBackendSessionId ?? null,
      backendSessionIdAtEnd: null,
      provenance: { kind: "task_runner" },
    };
    manifest.sessions.push(sessionRecord);
    manifest.totalAttemptCount = manifest.attemptRecords.length;
    manifest.totalSessionCount = manifest.sessions.length;
    refreshManifestAttachments(manifest);
    writeManifest(workspaceDir, manifest);
    withTaskStateLock(workspaceDir, () => {
      appendRunCreatedAudit(manifest);
      emitAuditEnvelope(
        appendRunStartedEvent({
          manifest,
          context: lifecycleContext,
          sessionIndex,
          backendSessionIdAtStart: sessionRecord.backendSessionIdAtStart,
          resumed: false,
        }),
      );
    });
  }

  emitEvent({
    type: "run_started",
    runId,
    agentName: agentConfig.name,
    assignmentSourcePath: loadedAssignment?.sourcePath ?? null,
    name,
    cwd,
    sessionIndex: isResume ? sessionIndex : null,
  });

  // Caller-instructions banner on fresh runs only. Resume and
  // ready-start skip the banner (the caller already saw it
  // on init or on the fresh run that created the workspace). See
  // the `callerInstructions` field doc on RunManifest for the rule.
  if (!isResume && !priorReady) {
    emitCallerInstructions(manifest.callerInstructions, emitEvent);
  }

  let sessionAttempts = 0;
  // Seed the per-attempt session id from one of three sources:
  //   1. resume target's manifest (regular resume OR ready-start
  //      against a manifest that imported a session via init time
  //      `--backend-session-id` — the value lives on the persisted manifest)
  //   2. bootstrapBackendSessionId (caller imported an existing session
  //      on a fresh run)
  //   3. null (fresh session — backend allocates a new id on first invoke)
  let sessionId: string | null =
    ((isResume || priorReady) && resume ? manifest.backendSessionId : null) ??
    opts.bootstrapBackendSessionId ??
    null;
  let currentPrompt = initialPrompt;
  const attemptTranscripts: string[] = [];
  type TerminalStatus = Exclude<RunCompletionStatus, "initialized">;
  let terminal: { status: TerminalStatus; exitCode: number } | null = null;
  let thrownError: unknown = null;
  let sawRunAbort = false;
  let sawResumeRejected = false;
  let pendingAttempt: {
    attemptNumber: number;
    attemptIndexInSession: number;
    startedAt: string;
    prompt: string;
    sessionIdAtStart: string | null;
  } | null = null;
  const captureRawBackendStdout = captureBackendStdout();
  const persistAttemptRecord = (record: {
    attemptNumber: number;
    attemptIndexInSession: number;
    startedAt: string;
    endedAt: string;
    prompt: string;
    sessionIdAtStart: string | null;
    sessionIdCaptured: string | null;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    timedOut: boolean;
    transcript: string | null;
    rawStdout: string;
    rawStderr: string;
    invalidStatuses: AttemptRecord["invalidStatuses"];
    backendSessionUpdate?:
      | {
          previousBackendSessionId: string | null;
          nextBackendSessionId: string | null;
        }
      | undefined;
  }): void => {
    const logPath = writeAttemptLog(workspaceDir, {
      schemaVersion: 3,
      runId,
      attemptNumber: record.attemptNumber,
      sessionIndex,
      attemptIndexInSession: record.attemptIndexInSession,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      stderr: record.rawStderr,
    });
    withTaskStateLock(workspaceDir, () => {
      tasks = refreshManifestTaskState(manifest);
      syncManifestTaskState(manifest, tasks);
      refreshManifestAttachments(manifest);
      const attemptRecord: AttemptRecord = {
        attemptNumber: record.attemptNumber,
        sessionIndex,
        attemptIndexInSession: record.attemptIndexInSession,
        startedAt: record.startedAt,
        endedAt: record.endedAt,
        prompt: record.prompt,
        sessionIdAtStart: record.sessionIdAtStart,
        sessionIdCaptured: record.sessionIdCaptured,
        exitCode: record.exitCode,
        signal: record.signal,
        timedOut: record.timedOut,
        transcript: record.transcript,
        logPath,
        invalidStatuses: record.invalidStatuses,
        provenance: { kind: "task_runner" },
      };
      manifest.attemptRecords.push(attemptRecord);
      manifest.totalAttemptCount = manifest.attemptRecords.length;

      if (sessionRecord.firstAttemptNumber === null) {
        sessionRecord.firstAttemptNumber = record.attemptNumber;
      }
      sessionRecord.lastAttemptNumber = record.attemptNumber;

      tryRefreshMutableManifestMetadata(manifest);
      writeManifest(workspaceDir, manifest);
      pendingAttempt = null;
      emitAuditEnvelope(
        appendRunAttemptRecordedEvent({
          manifest,
          context: lifecycleContext,
          sessionIndex,
          attemptNumber: record.attemptNumber,
          exitCode: record.exitCode,
          signal: record.signal,
          timedOut: record.timedOut,
          backendSessionIdAtStart: record.sessionIdAtStart,
          backendSessionIdCaptured: record.sessionIdCaptured,
        }),
      );
      if (record.backendSessionUpdate) {
        emitAuditEnvelope(
          appendRunBackendSessionUpdatedEvent({
            manifest,
            context: lifecycleContext,
            previousBackendSessionId: record.backendSessionUpdate.previousBackendSessionId,
            nextBackendSessionId: record.backendSessionUpdate.nextBackendSessionId,
            reason: "backend_capture",
            sessionIndex,
            attemptNumber: record.attemptNumber,
          }),
        );
      }
    });
  };
  const runLockedAttemptHooks = async (
    phase: "beforeAttempt" | "afterAttempt" | "afterExit",
    options: {
      sessionIndex: number;
      attemptIndexInSession: number;
      attemptNumber: number | null;
      retriesRemaining: number;
      attemptResult?: {
        exitCode: number | null;
        signal: NodeJS.Signals | null;
        timedOut: boolean;
        transcript: string | null;
        rawStdout: string;
        rawStderr: string;
        sessionId: string | null;
        aborted: boolean;
      };
    },
  ) => {
    return await withTaskStateLockAsync(workspaceDir, async () => {
      tasks = refreshManifestTaskState(manifest);
      refreshManifestAttachments(manifest);
      const hookState = createHookExecutionState(
        manifest,
        tasks,
        {
          initialPrompt,
          attemptPrompt: currentPrompt,
        },
        lifecycleContext,
      );
      const hookResult = await runAttemptHooks(phase, hookState, options);
      manifest = hookState.manifest;
      tasks = hookState.tasks;
      syncManifestTaskState(manifest, tasks);
      writeManifest(workspaceDir, manifest);
      return {
        hookResult,
        attemptPrompt: hookState.attemptPrompt,
      };
    });
  };

  try {
    while (sessionAttempts < maxAttemptsPerSession && !terminal) {
      tryRefreshMutableManifestMetadata(manifest);
      name = manifest.name;
      sessionAttempts++;
      const globalAttemptNumber = priorAttemptCount + sessionAttempts;
      const attemptIndexInSession = sessionAttempts - 1;
      const { hookResult: beforeAttemptResult, attemptPrompt: beforeAttemptPrompt } =
        await runLockedAttemptHooks("beforeAttempt", {
          sessionIndex,
          attemptIndexInSession,
          attemptNumber: globalAttemptNumber,
          retriesRemaining: maxAttemptsPerSession - sessionAttempts,
        });
      currentPrompt = beforeAttemptResult.followUpPrompt ?? beforeAttemptPrompt;
      cwd = manifest.cwd;
      model = manifest.model ?? undefined;
      effort = (manifest.effort ?? undefined) as RunOverrides["effort"];
      timeoutSec = manifest.timeoutSec;
      unrestricted = manifest.unrestricted;
      currentBackend = resolveRuntimeBackend(manifest.backend, backend);
      backendConfig = manifest.backendConfig;
      resolvedBackendArgs = cloneResolvedBackendArgs(manifest.resolvedBackendArgs);
      launcher = cloneResolvedLauncherConfig(manifest.launcher);
      if (beforeAttemptResult.status === "block") {
        terminal = { status: "blocked", exitCode: 2 };
        break;
      }
      const attemptStartedAt = new Date().toISOString();
      emitEvent({
        type: "attempt_started",
        attemptNumber: globalAttemptNumber,
        sessionIndex,
        attemptIndexInSession,
        startedAt: attemptStartedAt,
        prompt: currentPrompt,
      });

      const sessionIdAtStart = sessionId;
      pendingAttempt = {
        attemptNumber: globalAttemptNumber,
        attemptIndexInSession,
        startedAt: attemptStartedAt,
        prompt: currentPrompt,
        sessionIdAtStart,
      };
      const onRawStdoutLine = prepareAttemptStdoutSidecar({
        workspaceDir,
        attemptNumber: globalAttemptNumber,
        captureRawBackendStdout,
        emit: emitEvent,
      });

      const backendInvokeEnv = buildBackendInvokeEnv({
        recursionState,
        runId: manifest.runId,
        runGroupId: manifest.runGroupId,
        cwd,
      });
      const environmentLauncher = buildEnvironmentLauncher(
        manifest.executionEnvironment,
        backendInvokeEnv,
      );
      const invokeResult = await currentBackend.invoke({
        prompt: currentPrompt,
        cwd,
        env: backendInvokeEnv,
        model,
        effort,
        backendConfig: cloneBackendConfig(backendConfig),
        resolvedBackendArgs: cloneResolvedBackendArgs(manifest.resolvedBackendArgs),
        launcher: environmentLauncher ?? launcher,
        unrestricted,
        timeoutSec,
        resumeSessionId: sessionId ?? undefined,
        name: name ?? undefined,
        abortSignal: opts.abortSignal,
        emit: emitEvent,
        onRawStdoutLine,
      });
      const attemptEndedAt = new Date().toISOString();

      if (invokeResult.transcript) {
        attemptTranscripts.push(invokeResult.transcript);
      }

      const invokedWithResume = sessionIdAtStart !== null;
      const resumeRejected = invokedWithResume && resumeFailureDetector(invokeResult);
      const previousBackendSessionId = manifest.backendSessionId;
      let backendSessionUpdate:
        | {
            previousBackendSessionId: string | null;
            nextBackendSessionId: string | null;
          }
        | undefined;

      if (!resumeRejected && invokeResult.sessionId) {
        sessionId = invokeResult.sessionId;
        manifest.backendSessionId = invokeResult.sessionId;
        if (previousBackendSessionId !== invokeResult.sessionId) {
          backendSessionUpdate = {
            previousBackendSessionId,
            nextBackendSessionId: invokeResult.sessionId,
          };
        }
      }

      const mergeInfo = {
        invalidStatuses: [],
        missingFromFile: [],
        unknownInFile: [],
      };
      persistAttemptRecord({
        attemptNumber: globalAttemptNumber,
        attemptIndexInSession,
        startedAt: attemptStartedAt,
        endedAt: attemptEndedAt,
        prompt: currentPrompt,
        sessionIdAtStart,
        sessionIdCaptured: invokeResult.sessionId,
        exitCode: invokeResult.exitCode,
        signal: invokeResult.signal,
        timedOut: invokeResult.timedOut,
        transcript: invokeResult.transcript,
        rawStdout: invokeResult.rawStdout,
        rawStderr: invokeResult.rawStderr,
        invalidStatuses: mergeInfo.invalidStatuses,
        backendSessionUpdate,
      });
      const { hookResult: afterAttemptResult, attemptPrompt: afterAttemptPrompt } =
        await runLockedAttemptHooks("afterAttempt", {
          sessionIndex,
          attemptIndexInSession,
          attemptNumber: globalAttemptNumber,
          retriesRemaining: maxAttemptsPerSession - sessionAttempts,
          attemptResult: {
            exitCode: invokeResult.exitCode,
            signal: invokeResult.signal,
            timedOut: invokeResult.timedOut,
            transcript: invokeResult.transcript,
            rawStdout: invokeResult.rawStdout,
            rawStderr: invokeResult.rawStderr,
            sessionId: invokeResult.sessionId,
            aborted: invokeResult.aborted,
          },
        });
      currentPrompt = afterAttemptResult.followUpPrompt ?? afterAttemptPrompt;
      cwd = manifest.cwd;
      model = manifest.model ?? undefined;
      effort = (manifest.effort ?? undefined) as RunOverrides["effort"];
      timeoutSec = manifest.timeoutSec;
      unrestricted = manifest.unrestricted;
      currentBackend = resolveRuntimeBackend(manifest.backend, backend);
      backendConfig = manifest.backendConfig;
      resolvedBackendArgs = cloneResolvedBackendArgs(manifest.resolvedBackendArgs);
      launcher = cloneResolvedLauncherConfig(manifest.launcher);
      if (afterAttemptResult.status === "block") {
        terminal = { status: "blocked", exitCode: 2 };
        break;
      }
      if (
        manifest.schedule !== null &&
        tasks.size > 0 &&
        countBy(tasks, (t) => t.status === "completed") < tasks.size &&
        countBy(tasks, (t) => t.status === "blocked") === 0
      ) {
        terminal = { status: "ready", exitCode: 0 };
        break;
      }
      if (afterAttemptResult.status === "reinvoke") {
        if (sessionAttempts >= maxAttemptsPerSession) {
          terminal = { status: "exhausted", exitCode: 1 };
          break;
        }
        emitEvent({
          type: "retrying",
          incompleteCount: countBy(tasks, (t) => t.status !== "completed"),
          invalidStatusCount: 0,
        });
        emitAuditEnvelope(
          appendRunRetryingEvent({
            manifest,
            context: lifecycleContext,
            sessionIndex,
            incompleteCount: countBy(tasks, (t) => t.status !== "completed"),
            invalidStatusCount: 0,
          }),
        );
        continue;
      }
      if (invokeResult.aborted) {
        terminal = { status: "aborted", exitCode: 130 };
        sawRunAbort = true;
        emitEvent({ type: "run_aborted" });
        break;
      }

      if (resumeRejected) {
        terminal = { status: "error", exitCode: 4 };
        sawResumeRejected = true;
        emitEvent({ type: "resume_rejected" });
        break;
      }

      // Zero-task runs have no enforcement loop — the success criterion is
      // just "backend invocation succeeded". One attempt, check the backend
      // result, done.
      if (tasks.size === 0) {
        if (invokeResult.exitCode === 0 && !invokeResult.timedOut) {
          terminal = { status: "success", exitCode: 0 };
        } else {
          terminal = { status: "error", exitCode: 4 };
        }
        break;
      }

      const allCompleted = countBy(tasks, (t) => t.status === "completed") === tasks.size;
      const noInvalid = mergeInfo.invalidStatuses.length === 0;
      const blockedCount = countBy(tasks, (t) => t.status === "blocked");

      if (allCompleted && noInvalid) {
        terminal = { status: "success", exitCode: 0 };
        break;
      }
      if (blockedCount > 0) {
        terminal = { status: "blocked", exitCode: 2 };
        break;
      }
      if (manifest.schedule !== null) {
        terminal = { status: "ready", exitCode: 0 };
        break;
      }
      if (sessionAttempts >= maxAttemptsPerSession) {
        terminal = { status: "exhausted", exitCode: 1 };
        break;
      }

      const incompleteCount = countBy(tasks, (t) => t.status !== "completed");
      emitEvent({
        type: "retrying",
        incompleteCount,
        invalidStatusCount: mergeInfo.invalidStatuses.length,
      });
      emitAuditEnvelope(
        appendRunRetryingEvent({
          manifest,
          context: lifecycleContext,
          sessionIndex,
          incompleteCount,
          invalidStatusCount: mergeInfo.invalidStatuses.length,
        }),
      );

      currentPrompt = buildNudgeMessage(tasks, mergeInfo.invalidStatuses, runId);
    }
  } catch (error) {
    thrownError = error;
    if (pendingAttempt) {
      try {
        persistAttemptRecord({
          attemptNumber: pendingAttempt.attemptNumber,
          attemptIndexInSession: pendingAttempt.attemptIndexInSession,
          startedAt: pendingAttempt.startedAt,
          endedAt: new Date().toISOString(),
          prompt: pendingAttempt.prompt,
          sessionIdAtStart: pendingAttempt.sessionIdAtStart,
          sessionIdCaptured: null,
          exitCode: null,
          signal: null,
          timedOut: false,
          transcript: null,
          rawStdout: "",
          rawStderr: formatUnhandledAttemptError(error),
          invalidStatuses: [],
        });
      } catch (persistError) {
        thrownError = new AggregateError(
          [error, persistError],
          "task-runner: failed to persist the final attempt record",
        );
      }
      pendingAttempt = null;
    }
    terminal = { status: "error", exitCode: 4 };
  }

  if (!terminal) {
    terminal = { status: "error", exitCode: 4 };
  }
  let finalTerminal = terminal;

  let orderedTasks: TaskState[] = [];
  let tasksCompleted = 0;
  const endedAt = new Date().toISOString();
  withTaskStateLock(workspaceDir, () => {
    tasks = refreshManifestTaskState(manifest);
    tasks = normalizeInactiveNonPassiveTasks(manifest.backend, tasks);
    orderedTasks = syncManifestTaskState(manifest, tasks);
    tasksCompleted = manifest.tasksCompleted;
    refreshManifestAttachments(manifest);

    sessionRecord.status = finalTerminal.status;
    sessionRecord.exitCode = finalTerminal.exitCode;
    sessionRecord.endedAt = endedAt;
    sessionRecord.backendSessionIdAtEnd = manifest.backendSessionId;

    manifest.status = finalTerminal.status;
    manifest.exitCode = finalTerminal.status === "ready" ? null : finalTerminal.exitCode;
    manifest.endedAt = finalTerminal.status === "ready" ? null : endedAt;
    tryRefreshMutableManifestMetadata(manifest);
    writeManifest(workspaceDir, manifest);
    if (sawRunAbort) {
      emitAuditEnvelope(
        appendRunAbortedEvent({
          manifest,
          context: lifecycleContext,
          sessionIndex,
        }),
      );
    }
    if (sawResumeRejected) {
      emitAuditEnvelope(
        appendRunResumeRejectedEvent({
          manifest,
          context: lifecycleContext,
          sessionIndex,
        }),
      );
    }
    emitAuditEnvelope(
      appendRunFinishedEvent({
        manifest,
        context: lifecycleContext,
        terminalStatus: finalTerminal.status,
        exitCode: finalTerminal.exitCode,
        tasksCompleted: manifest.tasksCompleted,
        tasksTotal: manifest.tasksTotal,
        sessionIndex,
      }),
    );
  });

  try {
    await runLockedAttemptHooks("afterExit", {
      sessionIndex,
      attemptIndexInSession: sessionAttempts === 0 ? 0 : sessionAttempts - 1,
      attemptNumber: pendingAttempt?.attemptNumber ?? null,
      retriesRemaining: 0,
    });
  } catch {
    // afterExit failures are warning-only; preserve the terminal result.
  }

  if (
    manifest.executionEnvironment?.mode === "managed" &&
    !groupEnvironmentHasPendingUsers(manifest)
  ) {
    const cleanedEnvironment = await cleanupExecutionEnvironment(manifest.executionEnvironment);
    withTaskStateLock(workspaceDir, () => {
      const latest = resolveResumeTarget(workspaceDir).manifest;
      latest.executionEnvironment = cleanedEnvironment;
      writeManifest(workspaceDir, latest);
      manifest = latest;
    });
    const cleanupError =
      cleanedEnvironment?.mode === "managed" ? cleanedEnvironment.cleanup.lastError : null;
    emitAuditEnvelope(
      cleanupError
        ? appendRunContainerCleanupFailedEvent({
            manifest,
            context: lifecycleContext,
            error: cleanupError,
          })
        : appendRunContainerRemovedEvent({
            manifest,
            context: lifecycleContext,
          }),
    );
  }

  const recurrenceResult = withTaskStateLock(workspaceDir, () => {
    const latest = resolveResumeTarget(workspaceDir).manifest;
    const schedule = latest.schedule;
    if (schedule === null || schedule.recurrence === null || !schedule.enabled) {
      manifest = latest;
      return null;
    }
    if (
      finalTerminal.status !== "success" &&
      finalTerminal.status !== "ready" &&
      !schedule.recurrence.continueOnFailure
    ) {
      manifest = latest;
      return null;
    }
    const recurrenceNow = new Date();
    const previousSchedule: RunSchedule = {
      ...schedule,
      recurrence: {
        schedule: { ...schedule.recurrence.schedule },
        mode: schedule.recurrence.mode,
        continueOnFailure: schedule.recurrence.continueOnFailure,
      },
    };
    const scheduleReadyForAdvance = new Date(schedule.runAt).getTime() <= recurrenceNow.getTime();
    let advanced: ReturnType<typeof advanceRecurringSchedule>;
    if (scheduleReadyForAdvance) {
      try {
        advanced = advanceRecurringSchedule(schedule, recurrenceNow);
      } catch (error) {
        if (!(error instanceof ScheduleValidationError)) {
          throw error;
        }
        advanced = {
          schedule: {
            ...schedule,
            enabled: false,
          },
          disabledReason: "minimum_interval_violation",
        };
      }
    } else {
      advanced = { schedule, disabledReason: null };
    }
    const reason = advanced.disabledReason === null ? undefined : advanced.disabledReason;

    if (schedule.recurrence.mode === "clone") {
      const cloneManifest = buildRecurringCloneManifest({
        sourceManifest: latest,
        schedule: advanced.schedule,
        now: new Date().toISOString(),
      });
      mkdirSync(cloneManifest.workspaceDir, { recursive: true });
      copyFrozenAgentSeed(latest, cloneManifest.workspaceDir);
      copyFrozenAssignmentSeed(latest, cloneManifest.workspaceDir);
      copySeedAttachments(latest, cloneManifest);
      writeManifest(cloneManifest.workspaceDir, cloneManifest);
      latest.schedule = null;
      writeManifest(workspaceDir, latest);
      emitAuditEnvelope(
        appendRunCreatedEvent({
          manifest: cloneManifest,
          context: lifecycleContext,
          agentName: cloneManifest.agent.name,
          assignmentName: cloneManifest.assignment?.name ?? null,
          passive: cloneManifest.backend === "passive",
        }),
      );
      if (scheduleReadyForAdvance && advanced.disabledReason) {
        emitAuditEnvelope(
          appendRunScheduleDisabledEvent({
            manifest: cloneManifest,
            context: lifecycleContext,
            schedule: advanced.schedule,
            reason,
          }),
        );
      } else if (scheduleReadyForAdvance) {
        emitAuditEnvelope(
          appendRunScheduleAdvancedEvent({
            manifest: cloneManifest,
            context: lifecycleContext,
            previousSchedule,
            schedule: advanced.schedule,
            reason,
          }),
        );
      }
      emitAuditEnvelope(
        appendRunScheduleConsumedEvent({
          manifest: latest,
          context: lifecycleContext,
          schedule: previousSchedule,
        }),
      );
      manifest = latest;
      return { manifest: latest, promoted: false };
    }

    if (schedule.recurrence.mode === "reset") {
      applyRunResetSeed(latest);
    }
    latest.schedule = advanced.schedule;
    latest.status = "ready";
    latest.exitCode = null;
    latest.endedAt = null;
    writeManifest(workspaceDir, latest);
    if (scheduleReadyForAdvance && advanced.disabledReason) {
      emitAuditEnvelope(
        appendRunScheduleDisabledEvent({
          manifest: latest,
          context: lifecycleContext,
          schedule: advanced.schedule,
          reason,
        }),
      );
    } else if (scheduleReadyForAdvance) {
      emitAuditEnvelope(
        appendRunScheduleAdvancedEvent({
          manifest: latest,
          context: lifecycleContext,
          previousSchedule,
          schedule: advanced.schedule,
          reason,
        }),
      );
    }
    manifest = latest;
    return { manifest: latest, promoted: true };
  });

  if (recurrenceResult?.promoted) {
    manifest = recurrenceResult.manifest;
    finalTerminal = { status: "ready", exitCode: 0 };
    tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, manifest.finalTasks, false);
    orderedTasks = Array.from(tasks.values());
    tasksCompleted = manifest.tasksCompleted;
  }

  const summary: RunCompletionSummary = {
    status: finalTerminal.status,
    sessionAttemptCount: sessionAttempts,
    maxAttemptsPerSession,
    totalAttemptCount: manifest.totalAttemptCount,
    totalSessionCount: manifest.totalSessionCount,
    tasksCompleted,
    tasksTotal: orderedTasks.length,
    tasks: Array.from(tasks.values()),
    runId,
  };
  emitEvent({ type: "run_finished", summary });

  if (thrownError) {
    throw thrownError;
  }

  return {
    summary,
    exitCode: finalTerminal.exitCode,
    attemptTranscripts,
    runId,
    workspaceDir,
    manifest,
  };
}
