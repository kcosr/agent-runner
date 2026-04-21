import { copyFileSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { TaskState, TaskStatus } from "../../assignment/model.js";
import { resolveBackend } from "../../backends/registry.js";
import {
  deriveRepoKey,
  resolveRunWorkspaceDirForRepo,
  resolveTaskRunnerConfigDir,
  resolveTaskRunnerStateDir,
} from "../../config/runtime-paths.js";
import { resolveTaskRunnerCommand } from "../../task-runner-command.js";
import { normalizeOptionalRunName } from "../../util/run-name.js";
import { shortId } from "../../util/short-id.js";
import { cloneBackendSpecificConfig, isWsOrWssUrl } from "../backends/types.js";
import type {
  Backend,
  BackendEvent,
  BackendId,
  BackendInvokeResult,
  BackendSpecificConfig,
  CodexTransportConfig,
} from "../backends/types.js";
import { interpolate } from "../config/interpolate.js";
import { type ResolvedLauncherConfig, cloneResolvedLauncherConfig } from "../config/launchers.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import type { LockableField, VarDef } from "../config/schema.js";
import { resolveAssignmentHooks } from "../hooks/loader.js";
import { createHookExecutionState, runAttemptHooks, runPrepareHooks } from "../hooks/runtime.js";
import { resolveFreshLauncherConfig } from "./launchers.js";
import {
  type AttemptRecord,
  type ResolvedResumeTarget,
  ResumeError,
  type RunExecution,
  type RunManifest,
  type SessionRecord,
  type TaskSnapshot,
  buildRunResetSeed,
  resolveResumeTarget,
  snapshotTasks,
  workspaceAssignmentPath,
  writeAttemptLog,
  writeManifest,
} from "./manifest.js";
import { buildNudgeMessage } from "./nudge.js";
import {
  buildChildRecursionEnv,
  checkRecursionDepth,
  readRecursionState,
} from "./recursion-guard.js";
import {
  IMPLICIT_RESUME_MESSAGE,
  hasIncompleteTasks,
  missingResumeInputMessage,
} from "./resume-policy.js";
import {
  appendRunAbortedEvent,
  appendRunAttemptRecordedEvent,
  appendRunBackendSessionUpdatedEvent,
  appendRunCreatedEvent,
  appendRunFinishedEvent,
  appendRunResumeRejectedEvent,
  appendRunRetryingEvent,
  appendRunStartedEvent,
  lifecycleRunEventContext,
} from "./run-events.js";
import type { RunCompletionStatus, RunCompletionSummary } from "./status.js";

export { RecursionDepthError } from "./recursion-guard.js";
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

export interface RunOptions {
  loaded: LoadedAgent;
  loadedAssignment?: LoadedAssignment;
  cliVars: Record<string, string>;
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
  resumeFailureDetector?: (result: BackendInvokeResult) => boolean;
}

export interface RunOutcome {
  summary: RunCompletionSummary;
  exitCode: number;
  attemptTranscripts: string[];
  runId: string;
  assignmentPath: string;
  workspaceDir: string;
  manifest: RunManifest;
}

export type RunEvent =
  | {
      type: "run_initialized";
      runId: string;
      agentName: string;
      assignmentSourcePath: string | null;
      assignmentPath: string;
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
      assignmentPath: string;
      name: string | null;
      cwd: string;
      sessionIndex: number | null;
    }
  | {
      type: "attempt_started";
      attempt: number;
      sessionIndex: number;
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
    // maxRetries is stored on the manifest as maxAttempts (= retries + 1)
    // so the error message subtracts back to the authored value.
    ["maxRetries", overrides?.maxRetries, manifest.maxAttempts - 1],
    ["tasks", addedTasks.length > 0 ? addedTasks : undefined, undefined],
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
    assignmentPath: string;
    workspaceDir: string;
    maxAttempts: number;
    execution: RunExecution;
    sessionCount: number;
  },
): RunManifest {
  return {
    ...base,
    model: overrides.model,
    effort: overrides.effort,
    launcher: cloneResolvedLauncherConfig(overrides.launcher),
    brief: initialPrompt,
    name: overrides.name,
    unrestricted: overrides.unrestricted,
    cwd: overrides.cwd,
    timeoutSec: overrides.timeoutSec,
    assignmentPath: overrides.assignmentPath,
    workspaceDir: overrides.workspaceDir,
    endedAt: null,
    status: "running",
    exitCode: null,
    maxAttempts: overrides.maxAttempts,
    execution: overrides.execution,
    finalTasks: {},
    tasksCompleted: 0,
    tasksTotal: 0,
    sessionCount: overrides.sessionCount,
  };
}

const MAX_TITLE_LENGTH = 200;

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

function resolveConfiguredCwd(input: string | undefined, fallback: string): string {
  if (!input || input === ".") return fallback;
  return isAbsolute(input) ? input : resolve(fallback, input);
}

function resolveFreshRunCwd(
  assignment: LoadedAssignment | undefined,
  overrides: RunOverrides | undefined,
  callerCwd: string | undefined,
): string {
  const resolutionBase = callerCwd ?? process.cwd();
  if (overrides?.cwd !== undefined) {
    return resolveConfiguredCwd(overrides.cwd, resolutionBase);
  }
  if (assignment?.config.cwd !== undefined) {
    return resolveConfiguredCwd(assignment.config.cwd, resolutionBase);
  }
  return resolutionBase;
}

function codexTransportFromEnv(): CodexTransportConfig | undefined {
  const wsUrl = process.env.TASK_RUNNER_CODEX_WS_URL?.trim();
  if (!wsUrl) {
    return undefined;
  }
  if (!isWsOrWssUrl(wsUrl)) {
    throw new Error("TASK_RUNNER_CODEX_WS_URL must be an absolute ws:// or wss:// URL");
  }
  return {
    type: "ws",
    url: wsUrl,
  };
}

function resolveFreshBackendSpecific(
  backendId: BackendId,
  agentConfig: LoadedAgent["config"],
  overrides: RunOverrides | undefined,
  execution: RunExecution,
): BackendSpecificConfig | undefined {
  if (backendId !== "codex") {
    return undefined;
  }

  const authoredTransport = agentConfig.backendSpecific?.codex?.transport;
  if (authoredTransport) {
    return {
      codex: {
        transport: { ...authoredTransport },
      },
    };
  }

  const overrideTransport =
    execution.hostMode === "daemon" ? overrides?.backendSpecific?.codex?.transport : undefined;
  if (overrideTransport) {
    return {
      codex: {
        transport: { ...overrideTransport },
      },
    };
  }

  const envTransport = codexTransportFromEnv();
  if (envTransport) {
    return {
      codex: {
        transport: envTransport,
      },
    };
  }

  return {
    codex: {
      transport: {
        type: "stdio",
      },
    },
  };
}

function resolveManifestBackendSpecific(manifest: RunManifest): BackendSpecificConfig | undefined {
  if (manifest.backend !== "codex") {
    return cloneBackendSpecificConfig(manifest.backendSpecific);
  }
  const transport = manifest.backendSpecific?.codex?.transport;
  if (!transport) {
    throw new ResumeError(
      `cannot resume run ${manifest.runId} — frozen manifest has no resolved codex transport`,
    );
  }
  return {
    codex: {
      transport: { ...transport },
    },
  };
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
  if (typeof value !== "string") return value;
  switch (def.type) {
    case "string":
      return value;
    case "number": {
      const n = Number(value);
      if (Number.isNaN(n)) {
        throw new VarResolutionError(`var "${key}": expected number, got "${value}"`);
      }
      return n;
    }
    case "boolean":
      if (value === "true" || value === "1") return true;
      if (value === "false" || value === "0") return false;
      throw new VarResolutionError(`var "${key}": expected boolean, got "${value}"`);
    case "enum":
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

type ResolvedVarSource = "cli" | "env" | "default";

interface ResolvedVarsResult {
  values: Record<string, unknown>;
  sources: Record<string, ResolvedVarSource>;
}

interface RedactedRuntimeVar {
  redacted: true;
  source: "env";
  envName: string;
}

function redactRuntimeVars(
  values: Record<string, unknown>,
  sources: Record<string, ResolvedVarSource>,
  varsSchema: Record<string, VarDef>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(values)) {
    if (sources[key] === "env") {
      const envName = varsSchema[key]?.envName ?? key;
      const redacted: RedactedRuntimeVar = {
        redacted: true,
        source: "env",
        envName,
      };
      out[key] = redacted;
      continue;
    }
    out[key] = value;
  }
  return out;
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

function resolveVars(
  varsSchema: Record<string, VarDef>,
  cliVars: Record<string, string>,
): ResolvedVarsResult {
  const values: Record<string, unknown> = {};
  const sources: Record<string, ResolvedVarSource> = {};
  for (const [key, def] of Object.entries(varsSchema)) {
    let value: unknown;
    let source: ResolvedVarSource | undefined;

    if (def.source === "cli" || def.source === "either") {
      if (cliVars[key] !== undefined) {
        value = cliVars[key];
        source = "cli";
      }
    }
    if (value === undefined && (def.source === "env" || def.source === "either")) {
      const envName = def.envName ?? key;
      const envValue = process.env[envName];
      if (envValue !== undefined) {
        value = envValue;
        source = "env";
      }
    }
    if (value === undefined && def.default !== undefined) {
      value = def.default;
      source = "default";
    }
    if (value === undefined) {
      if (def.required && def.requiredAt !== "prepare") {
        throw new VarResolutionError(`missing required var: ${key}`);
      }
      continue;
    }

    values[key] = coerceVar(key, value, def);
    if (source) sources[key] = source;
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
      throw new VarResolutionError(`missing required ${requiredAt} var: ${key}`);
    }
  }
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
  return status === "completed" ? "completed" : "pending";
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
  const { loaded, loadedAssignment, cliVars, backend, overrides, resume } = opts;
  const emitEvent = opts.emitEvent ?? (() => {});
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
  const priorReady = !isInitialize && resume?.manifest.status === "ready";
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
    if (Object.keys(cliVars).length > 0) {
      throw new ResumeError(
        "--var cannot be combined with --resume-run — runtime vars are resolved from the assignment once at first write and frozen into the manifest; they are not re-resolved on resume.",
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
      if (overrides?.model !== undefined) forbidden.push("--model");
      if (overrides?.effort !== undefined) forbidden.push("--effort");
      if (overrides?.timeoutSec !== undefined) forbidden.push("--timeout-sec");
      if (overrides?.maxRetries !== undefined) forbidden.push("--max-retries");
      if (overrides?.unrestricted !== undefined) forbidden.push("--unrestricted");
      if (overrides?.name !== undefined) forbidden.push("--name");
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
  let cwd = reusesFrozenSetup
    ? resume.manifest.cwd
    : resolveFreshRunCwd(loadedAssignment, overrides, opts.callerCwd);
  let repo = reusesFrozenSetup ? resume.manifest.repo : deriveRepoKey(cwd);
  let effectiveBackendId = backend.id;
  let currentBackend = backend;
  // When --backend overrides the agent's backend, the agent's `model`
  // is also dropped (since model strings are backend-specific). Pass
  // --model alongside --backend to set one for the new backend.
  const backendOverridden = overrides?.backend !== undefined;
  let model = overrides?.model ?? (backendOverridden ? undefined : agentConfig.model);
  let effort = overrides?.effort ?? agentConfig.effort;
  const backendSpecific = reusesFrozenSetup
    ? resolveManifestBackendSpecific(resume.manifest)
    : resolveFreshBackendSpecific(effectiveBackendId, agentConfig, overrides, execution);
  const launcher = reusesFrozenSetup
    ? cloneResolvedLauncherConfig(resume.manifest.launcher)
    : resolveFreshLauncherConfig({
        backendId: effectiveBackendId,
        backendSpecific,
        agentLauncher: loaded.launcher,
        overrideLauncher: overrides?.launcher,
        cwd,
      });
  const message = overrides?.message ?? assignmentConfig?.message ?? null;
  let timeoutSec = overrides?.timeoutSec ?? agentConfig.timeoutSec;
  let unrestricted = overrides?.unrestricted ?? agentConfig.unrestricted;
  // maxRetries lives on the assignment. In chat mode (no assignment
  // loaded), fall back to a hard default of 3 to match the assignment
  // schema's own default.
  const maxRetries = overrides?.maxRetries ?? assignmentConfig?.maxRetries ?? 3;
  const maxAttempts = maxRetries + 1;

  if (isResume) {
    const hasMessage = Boolean(message && message.trim().length > 0);
    const hasAddedTasks = addedTitles.length > 0;
    const canResumeImplicitly = hasIncompleteTasks(resume?.manifest.finalTasks ?? {});
    if (!hasMessage && !hasAddedTasks && !canResumeImplicitly) {
      throw new ResumeError(missingResumeInputMessage());
    }
    if (!resume?.manifest.backendSessionId) {
      throw new ResumeError(
        `cannot resume run ${resume?.manifest.runId ?? "<unknown>"} — prior sessions captured no backend session id`,
      );
    }
  }

  if (
    opts.bootstrapBackendSessionId !== undefined &&
    currentBackend.supportsBootstrapSessionImport === false
  ) {
    throw new InvalidBackendSessionError(
      opts.bootstrapBackendSessionId,
      `${backend.id} backend-session import is unsupported because public ${backend.id} resume ids are not safely self-validating`,
    );
  }

  // If the caller is importing an existing backend session, validate
  // it via the backend's read-only check before any workspace
  // creation. Skipped silently for backends that don't implement
  // `validateSessionId`. We pass the resolved cwd because both
  // backends key session storage by it.
  if (opts.bootstrapBackendSessionId !== undefined && currentBackend.validateSessionId) {
    const result = await currentBackend.validateSessionId({
      sessionId: opts.bootstrapBackendSessionId,
      cwd,
      env: process.env as Record<string, string>,
      backendSpecific: cloneBackendSpecificConfig(backendSpecific),
    });
    if (!result.valid) {
      throw new InvalidBackendSessionError(opts.bootstrapBackendSessionId, result.reason);
    }
  }

  // Ready-start reuses the workspace and stored prompt from the earlier
  // `init` + `run ready` flow. Reinitialize also reuses the workspace
  // container, but rebuilds the manifest from fresh-init inputs.

  // Vars live on the assignment. Chat mode (no assignment) has no var
  // schema, so there is nothing to validate against or resolve from.
  const varsSchema = assignmentConfig?.vars ?? {};
  if (assignmentConfig) {
    assertKnownCliVars(varsSchema, cliVars);
  }
  const resolvedVars = resolveVars(varsSchema, cliVars);
  let runtimeVars = resolvedVars.values;
  validateRequiredVars(varsSchema, runtimeVars, "initial");
  let persistedRuntimeVars = redactRuntimeVars(runtimeVars, resolvedVars.sources, varsSchema);

  const reusingWorkspace = resume !== undefined;
  const runId = reusingWorkspace && resume ? resume.manifest.runId : shortId();
  const workspaceDir =
    reusingWorkspace && resume ? resume.workspaceDir : resolveRunWorkspaceDirForRepo(repo, runId);
  mkdirSync(workspaceDir, { recursive: true });
  const assignmentPath = workspaceAssignmentPath(workspaceDir);
  const assignmentName = loadedAssignment?.config.name ?? resume?.manifest.assignment?.name;

  // `injectedVars` has to be built *before* the task-map rebuild so
  // that fresh-run task titles and bodies get `{{var}}` references
  // substituted. Every field it needs (runtimeVars, assignmentPath,
  // runId, cwd) is known at this point.
  const injectedVars: Record<string, unknown> = {
    ...runtimeVars,
    assignment_path: assignmentPath,
    run_id: runId,
    cwd,
    config_dir: resolveTaskRunnerConfigDir(),
    state_dir: resolveTaskRunnerStateDir(),
    task_runner_cmd: resolveTaskRunnerCommand(),
    ...(assignmentName !== undefined ? { assignment_name: assignmentName } : {}),
  };
  const resolvedHookDescriptors =
    isResume || priorReady
      ? (resume?.manifest.resolvedHooks ?? [])
      : resolveAssignmentHooks(loadedAssignment, injectedVars);

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

  if (!isResume && !priorReady) {
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
      schemaVersion: 10,
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
            workspacePath: assignmentPath,
          }
        : null,
      backend: effectiveBackendId,
      model: model ?? null,
      effort: effort ?? null,
      backendSpecific: cloneBackendSpecificConfig(backendSpecific),
      launcher: cloneResolvedLauncherConfig(launcher),
      message,
      name: overrideName,
      note: null,
      pinned: false,
      unrestricted,
      cwd,
      lockedFields: initialLockedFields,
      timeoutSec,
      assignmentPath,
      workspaceDir,
      startedAt: new Date().toISOString(),
      endedAt: null,
      archivedAt: null,
      status: isInitialize ? "initialized" : "running",
      dependencyRunIds: [],
      exitCode: null,
      attempts: 0,
      maxAttempts,
      tasksCompleted: 0,
      tasksTotal: tasks.size,
      backendSessionId: opts.bootstrapBackendSessionId ?? null,
      runtimeVars: { ...runtimeVars },
      execution,
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
        backend: effectiveBackendId,
        model: model ?? null,
        effort: effort ?? null,
        backendSpecific: cloneBackendSpecificConfig(backendSpecific),
        launcher: cloneResolvedLauncherConfig(launcher),
        cwd,
        lockedFields: initialLockedFields,
        message,
        name: overrideName,
        note: null,
        pinned: false,
        dependencyRunIds: [],
        unrestricted,
        timeoutSec,
        maxAttempts,
        brief: "",
        runtimeVars: { ...runtimeVars },
        hookState: {},
        attachments: [],
        finalTasks: snapshotTasks(tasks),
      }),
      attachments: [],
      finalTasks: snapshotTasks(tasks),
      sessionCount: isInitialize ? 0 : 1,
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
    effectiveBackendId = prepareState.manifest.backend as BackendId;
    currentBackend = resolveRuntimeBackend(effectiveBackendId, backend);
    model = prepareState.manifest.model ?? undefined;
    effort = (prepareState.manifest.effort ?? undefined) as RunOverrides["effort"];
    timeoutSec = prepareState.manifest.timeoutSec;
    unrestricted = prepareState.manifest.unrestricted;
    runtimeVars = { ...prepareState.manifest.runtimeVars };
    hookState = { ...prepareState.manifest.hookState };
    hookAttachments = prepareState.manifest.attachments.map((attachment) => ({ ...attachment }));
    hookNote = prepareState.manifest.note;
    hookPinned = prepareState.manifest.pinned;
    hookLockedFields = [...prepareState.manifest.lockedFields];
    validateRequiredVars(varsSchema, runtimeVars, "prepare");
    persistedRuntimeVars = redactRuntimeVars(runtimeVars, resolvedVars.sources, varsSchema);
  }

  const hasTasks = tasks.size > 0;
  const firstTimeTasksAppear = isResume && !priorHadTasks && hasTasks;
  const resumeAddedNewTasks = isResume && priorHadTasks && addedTitles.length > 0;
  const resumeUsesImplicitContinueMessage =
    isResume &&
    trimmedMessage.length === 0 &&
    addedTitles.length === 0 &&
    hasIncompleteTasks(resume?.manifest.finalTasks ?? {});

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

  const now = new Date().toISOString();
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
      assignmentPath,
      workspaceDir,
      maxAttempts,
      execution,
      sessionCount: priorSessionCount + 1,
    });
  } else if (priorReady && resume) {
    // Start-after-ready: the manifest was persisted by `init`. Flip it
    // to "running", promote sessionCount to 1, and preserve the brief.
    manifest = {
      ...resume.manifest,
      brief: initialPrompt,
      name,
      endedAt: null,
      status: "running",
      exitCode: null,
      sessionCount: 1,
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
      schemaVersion: 10,
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
            workspacePath: assignmentPath,
          }
        : null,
      backend: effectiveBackendId,
      model: model ?? null,
      effort: effort ?? null,
      backendSpecific: cloneBackendSpecificConfig(backendSpecific),
      launcher: cloneResolvedLauncherConfig(launcher),
      message,
      name,
      note: hookNote,
      pinned: hookPinned,
      unrestricted,
      cwd,
      lockedFields: [...(hookLockedFields ?? frozenLockedFields)],
      timeoutSec,
      assignmentPath,
      workspaceDir,
      startedAt: now,
      endedAt: null,
      archivedAt: null,
      status: isInitialize ? "initialized" : "running",
      dependencyRunIds: [],
      exitCode: null,
      attempts: 0,
      maxAttempts,
      tasksCompleted: 0,
      tasksTotal: tasks.size,
      // If the caller imported an existing backend session, persist it
      // here at construction time. The first attempt's `sessionId`
      // local also seeds from this so the very first invocation does
      // a backend resume instead of starting a fresh session.
      backendSessionId: opts.bootstrapBackendSessionId ?? null,
      runtimeVars: persistedRuntimeVars,
      execution,
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
        backend: effectiveBackendId,
        model: model ?? null,
        effort: effort ?? null,
        backendSpecific: cloneBackendSpecificConfig(backendSpecific),
        launcher: cloneResolvedLauncherConfig(launcher),
        cwd,
        lockedFields: [...(hookLockedFields ?? frozenLockedFields)],
        message,
        name,
        note: hookNote,
        pinned: hookPinned,
        dependencyRunIds: [],
        unrestricted,
        timeoutSec,
        maxAttempts,
        brief: initialPrompt,
        runtimeVars: { ...persistedRuntimeVars },
        hookState: { ...hookState },
        attachments: hookAttachments.map((attachment) => ({ ...attachment })),
        finalTasks: snapshotTasks(tasks),
      }),
      attachments: hookAttachments.map((attachment) => ({ ...attachment })),
      finalTasks: {},
      sessionCount: isInitialize ? 0 : 1,
      sessions: [],
      attemptRecords: [],
    };
  }

  if (isReinitialize) {
    rmSync(`${workspaceDir}/attempts`, { recursive: true, force: true });
    rmSync(`${workspaceDir}/attachments`, { recursive: true, force: true });
  }

  if (loadedAssignment?.sourcePath) {
    copyFileSync(loadedAssignment.sourcePath, `${workspaceDir}/assignment-seed.md`);
  } else if (isReinitialize) {
    rmSync(`${workspaceDir}/assignment-seed.md`, { force: true });
  }

  const lifecycleContext = lifecycleRunEventContext(execution);
  const appendRunCreatedAudit = (targetManifest: RunManifest): void => {
    appendRunCreatedEvent({
      manifest: targetManifest,
      context: lifecycleContext,
      agentName: agentConfig.name,
      assignmentName: loadedAssignment?.config.name ?? null,
      passive: agentConfig.backend === "passive",
    });
    if (targetManifest.backendSessionId !== null) {
      appendRunBackendSessionUpdatedEvent({
        manifest: targetManifest,
        context: lifecycleContext,
        previousBackendSessionId: null,
        nextBackendSessionId: targetManifest.backendSessionId,
        reason: "bootstrap_import",
      });
    }
  };

  // `init` stops here: persist the prepared workspace + manifest and
  // return a terminal "initialized" outcome. No session is created; the
  // caller will follow up with `task-runner run --resume-run <id>` —
  // or, for passive agents, with `task-runner task set` / `task add`.
  if (isInitialize) {
    syncManifestTaskState(manifest, tasks);
    writeManifest(workspaceDir, manifest);
    const isPassive = agentConfig.backend === "passive";
    if (!isReinitialize) {
      appendRunCreatedAudit(manifest);
    }
    emitEvent({
      type: "run_initialized",
      runId,
      agentName: agentConfig.name,
      assignmentSourcePath: loadedAssignment?.sourcePath ?? null,
      assignmentPath,
      name,
      cwd,
      passive: isPassive,
      brief: initialPrompt,
    });
    emitCallerInstructions(manifest.callerInstructions, emitEvent);
    return {
      summary: {
        status: "initialized",
        attempts: 0,
        maxAttempts,
        tasksCompleted: 0,
        tasksTotal: tasks.size,
        assignmentPath,
        tasks: Array.from(tasks.values()),
        runId,
      },
      exitCode: 0,
      attemptTranscripts: [],
      runId,
      assignmentPath,
      workspaceDir,
      manifest,
    };
  }

  const addedTasks =
    reusingWorkspace && resume && !priorReady
      ? collectNewTasks(tasks, resume.manifest.finalTasks)
      : [];
  let sessionRecord: SessionRecord;
  if (reusingWorkspace) {
    withTaskStateLock(workspaceDir, () => {
      const latest = resolveResumeTarget(workspaceDir).manifest;
      if (latest.archivedAt !== null) {
        throw new ResumeError(
          `cannot resume archived run ${latest.runId} — unarchive it first with ${resolveTaskRunnerCommand()} run unarchive ${latest.runId}`,
        );
      }
      if (latest.status === "running") {
        throw new ResumeError(`cannot resume run ${latest.runId} — it is already running`);
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
          assignmentPath,
          workspaceDir,
          maxAttempts,
          execution,
          sessionCount: priorSessionCount + 1,
        });
      } else {
        manifest = {
          ...latest,
          brief: initialPrompt,
          name,
          endedAt: null,
          status: "running",
          exitCode: null,
          sessionCount: 1,
          execution,
        };
      }

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
        firstAttempt: null,
        lastAttempt: null,
        maxAttempts,
        backendSessionIdAtStart: latest.backendSessionId,
        backendSessionIdAtEnd: null,
      };
      manifest.sessions.push(sessionRecord);
      writeManifest(workspaceDir, manifest);
      appendRunStartedEvent({
        manifest,
        context: lifecycleContext,
        sessionIndex,
        backendSessionIdAtStart: sessionRecord.backendSessionIdAtStart,
        resumed: priorSessionCount > 0,
      });
    });
  } else {
    syncManifestTaskState(manifest, tasks);
    sessionRecord = {
      sessionIndex,
      startedAt: now,
      endedAt: null,
      status: "running",
      exitCode: null,
      message: message,
      brief: initialPrompt,
      firstAttempt: null,
      lastAttempt: null,
      maxAttempts,
      backendSessionIdAtStart: opts.bootstrapBackendSessionId ?? null,
      backendSessionIdAtEnd: null,
    };
    manifest.sessions.push(sessionRecord);
    refreshManifestAttachments(manifest);
    writeManifest(workspaceDir, manifest);
    appendRunCreatedAudit(manifest);
    appendRunStartedEvent({
      manifest,
      context: lifecycleContext,
      sessionIndex,
      backendSessionIdAtStart: sessionRecord.backendSessionIdAtStart,
      resumed: false,
    });
  }

  emitEvent({
    type: "run_started",
    runId,
    agentName: agentConfig.name,
    assignmentSourcePath: loadedAssignment?.sourcePath ?? null,
    assignmentPath,
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
    ((isResume || priorReady) && resume ? resume.manifest.backendSessionId : null) ??
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
    attempt: number;
    startedAt: string;
    prompt: string;
    sessionIdAtStart: string | null;
  } | null = null;
  const persistAttemptRecord = (record: {
    attempt: number;
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
      schemaVersion: 1,
      runId,
      attempt: record.attempt,
      sessionIndex,
      startedAt: record.startedAt,
      endedAt: record.endedAt,
      stdout: record.rawStdout,
      stderr: record.rawStderr,
    });
    withTaskStateLock(workspaceDir, () => {
      tasks = refreshManifestTaskState(manifest);
      syncManifestTaskState(manifest, tasks);
      refreshManifestAttachments(manifest);
      const attemptRecord: AttemptRecord = {
        attempt: record.attempt,
        sessionIndex,
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
        tasksAfter: manifest.finalTasks,
        invalidStatuses: record.invalidStatuses,
      };
      manifest.attemptRecords.push(attemptRecord);
      manifest.attempts = manifest.attemptRecords.length;

      if (sessionRecord.firstAttempt === null) {
        sessionRecord.firstAttempt = record.attempt;
      }
      sessionRecord.lastAttempt = record.attempt;

      tryRefreshMutableManifestMetadata(manifest);
      writeManifest(workspaceDir, manifest);
      pendingAttempt = null;
      appendRunAttemptRecordedEvent({
        manifest,
        context: lifecycleContext,
        sessionIndex,
        attempt: record.attempt,
        exitCode: record.exitCode,
        signal: record.signal,
        timedOut: record.timedOut,
        backendSessionIdAtStart: record.sessionIdAtStart,
        backendSessionIdCaptured: record.sessionIdCaptured,
      });
      if (record.backendSessionUpdate) {
        appendRunBackendSessionUpdatedEvent({
          manifest,
          context: lifecycleContext,
          previousBackendSessionId: record.backendSessionUpdate.previousBackendSessionId,
          nextBackendSessionId: record.backendSessionUpdate.nextBackendSessionId,
          reason: "backend_capture",
          sessionIndex,
          attempt: record.attempt,
        });
      }
    });
  };
  const runLockedAttemptHooks = async (
    phase: "beforeAttempt" | "afterAttempt" | "afterExit",
    options: {
      sessionIndex: number;
      attempt: number | null;
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
    while (sessionAttempts < maxAttempts && !terminal) {
      tryRefreshMutableManifestMetadata(manifest);
      name = manifest.name;
      sessionAttempts++;
      const globalAttemptNumber = priorAttemptCount + sessionAttempts;
      const { hookResult: beforeAttemptResult, attemptPrompt: beforeAttemptPrompt } =
        await runLockedAttemptHooks("beforeAttempt", {
          sessionIndex,
          attempt: globalAttemptNumber,
          retriesRemaining: maxAttempts - sessionAttempts,
        });
      currentPrompt = beforeAttemptResult.followUpPrompt ?? beforeAttemptPrompt;
      cwd = manifest.cwd;
      model = manifest.model ?? undefined;
      effort = (manifest.effort ?? undefined) as RunOverrides["effort"];
      timeoutSec = manifest.timeoutSec;
      unrestricted = manifest.unrestricted;
      currentBackend = resolveRuntimeBackend(manifest.backend, backend);
      if (beforeAttemptResult.status === "block") {
        terminal = { status: "blocked", exitCode: 2 };
        break;
      }
      const attemptStartedAt = new Date().toISOString();
      emitEvent({
        type: "attempt_started",
        attempt: globalAttemptNumber,
        sessionIndex,
        startedAt: attemptStartedAt,
        prompt: currentPrompt,
      });

      const sessionIdAtStart = sessionId;
      pendingAttempt = {
        attempt: globalAttemptNumber,
        startedAt: attemptStartedAt,
        prompt: currentPrompt,
        sessionIdAtStart,
      };

      const invokeResult = await currentBackend.invoke({
        prompt: currentPrompt,
        cwd,
        env: {
          ...(process.env as Record<string, string>),
          // Increment recursion depth so a nested `task-runner run` spawned
          // by this backend can detect it. Always last so it overrides any
          // stale value the parent inherited.
          ...buildChildRecursionEnv(recursionState),
        },
        model,
        effort,
        backendSpecific,
        launcher,
        unrestricted,
        timeoutSec,
        resumeSessionId: sessionId ?? undefined,
        name: name ?? undefined,
        abortSignal: opts.abortSignal,
        emit: emitEvent,
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
        attempt: globalAttemptNumber,
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
          attempt: globalAttemptNumber,
          retriesRemaining: maxAttempts - sessionAttempts,
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
      if (afterAttemptResult.status === "block") {
        terminal = { status: "blocked", exitCode: 2 };
        break;
      }
      if (afterAttemptResult.status === "reinvoke") {
        if (sessionAttempts >= maxAttempts) {
          terminal = { status: "exhausted", exitCode: 1 };
          break;
        }
        emitEvent({
          type: "retrying",
          incompleteCount: countBy(tasks, (t) => t.status !== "completed"),
          invalidStatusCount: 0,
        });
        appendRunRetryingEvent({
          manifest,
          context: lifecycleContext,
          sessionIndex,
          incompleteCount: countBy(tasks, (t) => t.status !== "completed"),
          invalidStatusCount: 0,
        });
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
      if (sessionAttempts >= maxAttempts) {
        terminal = { status: "exhausted", exitCode: 1 };
        break;
      }

      const incompleteCount = countBy(tasks, (t) => t.status !== "completed");
      emitEvent({
        type: "retrying",
        incompleteCount,
        invalidStatusCount: mergeInfo.invalidStatuses.length,
      });
      appendRunRetryingEvent({
        manifest,
        context: lifecycleContext,
        sessionIndex,
        incompleteCount,
        invalidStatusCount: mergeInfo.invalidStatuses.length,
      });

      currentPrompt = buildNudgeMessage(tasks, mergeInfo.invalidStatuses, runId);
    }
  } catch (error) {
    thrownError = error;
    if (pendingAttempt) {
      try {
        persistAttemptRecord({
          attempt: pendingAttempt.attempt,
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

  let orderedTasks: TaskState[] = [];
  let tasksCompleted = 0;
  const endedAt = new Date().toISOString();
  withTaskStateLock(workspaceDir, () => {
    tasks = refreshManifestTaskState(manifest);
    tasks = normalizeInactiveNonPassiveTasks(manifest.backend, tasks);
    orderedTasks = syncManifestTaskState(manifest, tasks);
    tasksCompleted = manifest.tasksCompleted;
    refreshManifestAttachments(manifest);

    sessionRecord.status = terminal.status;
    sessionRecord.exitCode = terminal.exitCode;
    sessionRecord.endedAt = endedAt;
    sessionRecord.backendSessionIdAtEnd = manifest.backendSessionId;

    manifest.status = terminal.status;
    manifest.exitCode = terminal.exitCode;
    manifest.endedAt = endedAt;
    tryRefreshMutableManifestMetadata(manifest);
    writeManifest(workspaceDir, manifest);
    if (sawRunAbort) {
      appendRunAbortedEvent({
        manifest,
        context: lifecycleContext,
        sessionIndex,
      });
    }
    if (sawResumeRejected) {
      appendRunResumeRejectedEvent({
        manifest,
        context: lifecycleContext,
        sessionIndex,
      });
    }
    appendRunFinishedEvent({
      manifest,
      context: lifecycleContext,
      terminalStatus: terminal.status,
      exitCode: terminal.exitCode,
      tasksCompleted: manifest.tasksCompleted,
      tasksTotal: manifest.tasksTotal,
      sessionIndex,
    });
  });

  try {
    await runLockedAttemptHooks("afterExit", {
      sessionIndex,
      attempt: pendingAttempt?.attempt ?? null,
      retriesRemaining: 0,
    });
  } catch {
    // afterExit failures are warning-only; preserve the terminal result.
  }

  const summary: RunCompletionSummary = {
    status: terminal.status,
    attempts: sessionAttempts,
    maxAttempts,
    tasksCompleted,
    tasksTotal: orderedTasks.length,
    assignmentPath,
    tasks: Array.from(tasks.values()),
    runId,
  };
  emitEvent({ type: "run_finished", summary });

  if (thrownError) {
    throw thrownError;
  }

  return {
    summary,
    exitCode: terminal.exitCode,
    attemptTranscripts,
    runId,
    assignmentPath,
    workspaceDir,
    manifest,
  };
}
