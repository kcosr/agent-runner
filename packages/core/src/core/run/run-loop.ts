import { copyFileSync, mkdirSync, readFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { TaskState, TaskStatus } from "../../assignment/model.js";
import { resolveRunWorkspaceDir } from "../../config/runtime-paths.js";
import { resolveTaskRunnerCommand } from "../../task-runner-command.js";
import { normalizeOptionalRunName } from "../../util/run-name.js";
import { shortId } from "../../util/short-id.js";
import type { Backend, BackendEvent, BackendId, BackendInvokeResult } from "../backends/types.js";
import { interpolate } from "../config/interpolate.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loaded.js";
import type { LockableField, VarDef } from "../config/schema.js";
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
import type { RunCompletionStatus, RunCompletionSummary } from "./status.js";

export { RecursionDepthError } from "./recursion-guard.js";
import { WORKER_BRIEF_TEMPLATE, buildAddedTasksReminder } from "./task-workflow.js";
import {
  refreshManifestAttachments,
  refreshManifestTaskState,
  syncManifestTaskState,
  withTaskStateLock,
} from "./workspace-state.js";

export interface RunOverrides {
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
    ["cwd", overrides?.cwd, agentConfig.cwd],
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
// for execute-after-init (priorInitialized) as a defense-in-depth
// backstop — the explicit per-field "no overrides on init" list
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

function refreshMutableManifestName(manifest: RunManifest): void {
  const latest = resolveResumeTarget(manifest.workspaceDir).manifest;
  manifest.name = latest.name;
  manifest.resetSeed.name = latest.resetSeed.name;
  manifest.attachments = latest.attachments.map((attachment) => ({ ...attachment }));
}

function tryRefreshMutableManifestName(manifest: RunManifest): void {
  try {
    refreshMutableManifestName(manifest);
  } catch {
    // Mutable name refresh is best-effort; keep the in-memory name if
    // the manifest cannot be re-read transiently.
  }
}

function resolveConfiguredCwd(input: string | undefined, fallback: string): string {
  if (!input || input === ".") return fallback;
  return isAbsolute(input) ? input : resolve(fallback, input);
}

function resolveFreshRunCwd(
  loaded: LoadedAgent,
  overrides: RunOverrides | undefined,
  callerCwd: string | undefined,
): string {
  const resolutionBase = callerCwd ?? process.cwd();
  if (overrides?.cwd !== undefined) {
    return resolveConfiguredCwd(overrides.cwd, resolutionBase);
  }
  if (loaded.cwdSource === "explicit") {
    return resolveConfiguredCwd(loaded.config.cwd, resolutionBase);
  }
  return resolutionBase;
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
      if (def.required) {
        throw new VarResolutionError(`missing required var: ${key}`);
      }
      continue;
    }

    values[key] = coerceVar(key, value, def);
    if (source) sources[key] = source;
  }
  return { values, sources };
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

function countBy(tasks: Map<string, TaskState>, predicate: (t: TaskState) => boolean): number {
  let n = 0;
  for (const task of tasks.values()) {
    if (predicate(task)) n++;
  }
  return n;
}

function normalizeResumeStatus(status: TaskStatus): TaskStatus {
  return status === "completed" ? "completed" : "pending";
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
  const priorInitialized = resume?.manifest.status === "initialized";
  const isResume = Boolean(resume) && !priorInitialized;

  if (isInitialize && resume) {
    throw new ResumeError("--init cannot be combined with --resume-run");
  }
  if (resume && resume.manifest.archivedAt !== null) {
    throw new ResumeError(
      `cannot resume archived run ${resume.manifest.runId} — unarchive it first with ${resolveTaskRunnerCommand()} run unarchive ${resume.manifest.runId}`,
    );
  }
  if (resume && !priorInitialized && resume.manifest.status === "running") {
    throw new ResumeError(`cannot resume run ${resume.manifest.runId} — it is already running`);
  }

  // Resume override policy. The CLI also enforces most of these
  // earlier (with flag-level error messages), but these checks are
  // defense in depth for programmatic callers that construct
  // `RunOptions` directly — they bypass the CLI entirely and would
  // otherwise be able to violate the manifest-canonical contract.
  // Mirrors the policy matrix documented in docs/design.md under
  // "--resume-run".
  if (isResume || priorInitialized) {
    // Fields that are never valid on any resume (regular or
    // execute-after-init), regardless of prior status.
    if (loadedAssignment) {
      throw new ResumeError(
        priorInitialized
          ? "--assignment cannot be combined with resuming an initialized run"
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
    if (Object.keys(cliVars).length > 0) {
      throw new ResumeError(
        "--var cannot be combined with --resume-run — runtime vars are resolved from the assignment once at first write and frozen into the manifest; they are not re-resolved on resume.",
      );
    }
    if (overrides?.name !== undefined) {
      throw new ResumeError("--name cannot be combined with --resume-run");
    }

    // Execute-after-init is stricter: no overrides at all. Init
    // deliberately froze every resolvable field at creation time,
    // and the only valid invocation is `run --resume-run <id>`.
    if (priorInitialized) {
      const forbidden: string[] = [];
      if (overrides?.message && overrides.message.trim().length > 0) forbidden.push("message");
      if ((overrides?.addedTasks?.length ?? 0) > 0) forbidden.push("--add-task");
      if (overrides?.model !== undefined) forbidden.push("--model");
      if (overrides?.effort !== undefined) forbidden.push("--effort");
      if (overrides?.timeoutSec !== undefined) forbidden.push("--timeout-sec");
      if (overrides?.maxRetries !== undefined) forbidden.push("--max-retries");
      if (overrides?.unrestricted !== undefined) forbidden.push("--unrestricted");
      if (overrides?.name !== undefined) forbidden.push("--name");
      if (forbidden.length > 0) {
        throw new ResumeError(
          `resuming an initialized run does not accept ${forbidden.join(", ")} — init froze these at creation. If you need different values, create a fresh run.`,
        );
      }
    }
  }

  const addedTitles = overrides?.addedTasks ?? [];
  const agentInstructions = loaded.instructions.trim();
  const assignmentInstructions = loadedAssignment?.instructions.trim() ?? "";

  // Locked-field enforcement. For fresh runs and regular resumes,
  // `checkLockedFields` vets every CLI override against the agent's
  // and assignment's lockedFields. For execute-after-init we run a
  // defensive second pass against the **frozen** `manifest.lockedFields`
  // union — the per-field override list above should already have
  // rejected everything, but if a future addition to RunOverrides
  // forgets to be added to that list, this catches the regression
  // instead of silently letting it through.
  if (!priorInitialized) {
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

  const cwd = resume ? resume.manifest.cwd : resolveFreshRunCwd(loaded, overrides, opts.callerCwd);
  // When --backend overrides the agent's backend, the agent's `model`
  // is also dropped (since model strings are backend-specific). Pass
  // --model alongside --backend to set one for the new backend.
  const backendOverridden = overrides?.backend !== undefined;
  const model = overrides?.model ?? (backendOverridden ? undefined : agentConfig.model);
  const effort = overrides?.effort ?? agentConfig.effort;
  const message = overrides?.message ?? assignmentConfig?.message ?? null;
  const timeoutSec = overrides?.timeoutSec ?? agentConfig.timeoutSec;
  const unrestricted = overrides?.unrestricted ?? agentConfig.unrestricted;
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
    backend.supportsBootstrapSessionImport === false
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
  if (opts.bootstrapBackendSessionId !== undefined && backend.validateSessionId) {
    const result = await backend.validateSessionId({
      sessionId: opts.bootstrapBackendSessionId,
      cwd,
      env: process.env as Record<string, string>,
    });
    if (!result.valid) {
      throw new InvalidBackendSessionError(opts.bootstrapBackendSessionId, result.reason);
    }
  }

  // `priorInitialized` short-circuits most of the fresh-run setup below
  // because the workspace and prompt were already persisted by the earlier
  // `init`. We reuse the runId + workspace and use the stored prompt
  // verbatim for session 0's first attempt.

  // Vars live on the assignment. Chat mode (no assignment) has no var
  // schema, so there is nothing to validate against or resolve from.
  const varsSchema = assignmentConfig?.vars ?? {};
  if (assignmentConfig) {
    assertKnownCliVars(varsSchema, cliVars);
  }
  const resolvedVars = resolveVars(varsSchema, cliVars);
  const runtimeVars = resolvedVars.values;
  const persistedRuntimeVars = redactRuntimeVars(runtimeVars, resolvedVars.sources, varsSchema);

  const reusingWorkspace = (isResume && resume) || (priorInitialized && resume);
  const runId = reusingWorkspace && resume ? resume.manifest.runId : shortId();
  const workspaceDir =
    reusingWorkspace && resume ? resume.workspaceDir : resolveRunWorkspaceDir(cwd, runId);
  mkdirSync(workspaceDir, { recursive: true });
  const assignmentPath = workspaceAssignmentPath(workspaceDir);

  // `injectedVars` has to be built *before* the task-map rebuild so
  // that fresh-run task titles and bodies get `{{var}}` references
  // substituted. Every field it needs (runtimeVars, assignmentPath,
  // runId, cwd) is known at this point.
  const injectedVars: Record<string, unknown> = {
    ...runtimeVars,
    assignment_path: assignmentPath,
    run_id: runId,
    cwd,
    task_runner_cmd: resolveTaskRunnerCommand(),
  };

  const priorHadTasks = Boolean(
    isResume && resume && Object.keys(resume.manifest.finalTasks).length > 0,
  );

  let tasks: Map<string, TaskState>;
  if (isResume && resume) {
    tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, resume.manifest.finalTasks, true);
  } else if (priorInitialized && resume) {
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

  const hasTasks = tasks.size > 0;
  const firstTimeTasksAppear = isResume && !priorHadTasks && hasTasks;
  const resumeAddedNewTasks = isResume && priorHadTasks && addedTitles.length > 0;
  const trimmedMessage = message?.trim() ?? "";
  const resumeUsesImplicitContinueMessage =
    isResume &&
    trimmedMessage.length === 0 &&
    addedTitles.length === 0 &&
    hasIncompleteTasks(resume?.manifest.finalTasks ?? {});

  // Run name resolution: fresh `run` / `init` may set it via the
  // CLI override, while resume and execute-after-init always reuse
  // the persisted manifest value.
  const overrideName = normalizeRunName(overrides?.name);
  let name =
    overrideName ?? ((isResume || priorInitialized) && resume ? resume.manifest.name : null);

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
  // Execute-after-init: reuse the stored brief verbatim.
  //
  // Both message-last. Fresh runs error if parts is empty.
  let initialPrompt: string;
  if (priorInitialized && resume) {
    const stored = resume.manifest.brief;
    if (stored.length === 0) {
      throw new ResumeError(
        `cannot resume initialized run ${resume.manifest.runId} — manifest has no brief`,
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
    if (trimmedMessage.length > 0) {
      parts.push(trimmedMessage);
    }
    if (parts.length === 0) {
      throw new EmptyPromptError();
    }
    initialPrompt = parts.join("\n\n");
  }

  const now = new Date().toISOString();
  let priorAttemptCount = isResume && resume ? resume.manifest.attemptRecords.length : 0;
  let priorSessionCount = isResume && resume ? resume.manifest.sessions.length : 0;
  // `priorInitialized` runs start at session 0 — init never created a session.
  let sessionIndex = priorInitialized ? 0 : priorSessionCount;

  let manifest: RunManifest;
  if (isResume && resume) {
    manifest = buildResumeSessionManifest(resume.manifest, initialPrompt, {
      model: model ?? null,
      effort: effort ?? null,
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
  } else if (priorInitialized && resume) {
    // Execute-after-init: the manifest was persisted by `init`. Flip it
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
      schemaVersion: 7,
      runId,
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
      backend: overrides?.backend ?? agentConfig.backend,
      model: model ?? null,
      effort: effort ?? null,
      message,
      name,
      unrestricted,
      cwd,
      lockedFields: frozenLockedFields,
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
      callerInstructions: frozenCallerInstructions,
      resetSeed: buildRunResetSeed({
        model: model ?? null,
        effort: effort ?? null,
        name,
        dependencyRunIds: [],
        unrestricted,
        timeoutSec,
        maxAttempts,
        brief: initialPrompt,
        finalTasks: snapshotTasks(tasks),
      }),
      attachments: [],
      finalTasks: {},
      sessionCount: isInitialize ? 0 : 1,
      sessions: [],
      attemptRecords: [],
    };
  }

  if (!reusingWorkspace && loadedAssignment?.sourcePath) {
    copyFileSync(loadedAssignment.sourcePath, `${workspaceDir}/assignment-seed.md`);
  }

  // `init` stops here: persist the prepared workspace + manifest and
  // return a terminal "initialized" outcome. No session is created; the
  // caller will follow up with `task-runner run --resume-run <id>` —
  // or, for passive agents, with `task-runner task set` / `task add`.
  if (isInitialize) {
    syncManifestTaskState(manifest, tasks);
    writeManifest(workspaceDir, manifest);
    const isPassive = agentConfig.backend === "passive";
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
    reusingWorkspace && resume ? collectNewTasks(tasks, resume.manifest.finalTasks) : [];
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
      sessionIndex = priorInitialized ? 0 : priorSessionCount;
      tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, latest.finalTasks, isResume);
      for (const task of addedTasks) {
        tasks.set(task.id, { ...task });
      }

      if (isResume) {
        manifest = buildResumeSessionManifest(latest, initialPrompt, {
          model: model ?? null,
          effort: effort ?? null,
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
        message: priorInitialized ? latest.message : message,
        brief: initialPrompt,
        firstAttempt: null,
        lastAttempt: null,
        maxAttempts,
        backendSessionIdAtStart: isResume ? latest.backendSessionId : null,
        backendSessionIdAtEnd: null,
      };
      manifest.sessions.push(sessionRecord);
      writeManifest(workspaceDir, manifest);
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
      backendSessionIdAtStart: null,
      backendSessionIdAtEnd: null,
    };
    manifest.sessions.push(sessionRecord);
    refreshManifestAttachments(manifest);
    writeManifest(workspaceDir, manifest);
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
  // execute-after-init skip the banner (the caller already saw it
  // on init or on the fresh run that created the workspace). See
  // the `callerInstructions` field doc on RunManifest for the rule.
  if (!isResume && !priorInitialized) {
    emitCallerInstructions(manifest.callerInstructions, emitEvent);
  }

  let sessionAttempts = 0;
  // Seed the per-attempt session id from one of three sources:
  //   1. resume target's manifest (regular resume OR execute-after-init
  //      against a manifest that imported a session via init time
  //      `--backend-session-id` — the value lives on the persisted manifest)
  //   2. bootstrapBackendSessionId (caller imported an existing session
  //      on a fresh run)
  //   3. null (fresh session — backend allocates a new id on first invoke)
  let sessionId: string | null =
    ((isResume || priorInitialized) && resume ? resume.manifest.backendSessionId : null) ??
    opts.bootstrapBackendSessionId ??
    null;
  let currentPrompt = initialPrompt;
  const attemptTranscripts: string[] = [];
  let terminal: { status: RunCompletionStatus; exitCode: number } | null = null;

  while (sessionAttempts < maxAttempts && !terminal) {
    tryRefreshMutableManifestName(manifest);
    name = manifest.name;
    sessionAttempts++;
    const globalAttemptNumber = priorAttemptCount + sessionAttempts;
    emitEvent({ type: "attempt_started", attempt: globalAttemptNumber });

    const sessionIdAtStart = sessionId;
    const attemptStartedAt = new Date().toISOString();

    const invokeResult = await backend.invoke({
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

    if (!resumeRejected && invokeResult.sessionId) {
      sessionId = invokeResult.sessionId;
      manifest.backendSessionId = invokeResult.sessionId;
    }

    const logPath = writeAttemptLog(workspaceDir, {
      schemaVersion: 1,
      runId,
      attempt: globalAttemptNumber,
      sessionIndex,
      startedAt: attemptStartedAt,
      endedAt: attemptEndedAt,
      stdout: invokeResult.rawStdout,
      stderr: invokeResult.rawStderr,
    });
    const mergeInfo = {
      invalidStatuses: [],
      missingFromFile: [],
      unknownInFile: [],
    };
    withTaskStateLock(workspaceDir, () => {
      tasks = refreshManifestTaskState(manifest);
      syncManifestTaskState(manifest, tasks);
      refreshManifestAttachments(manifest);
      const attemptRecord: AttemptRecord = {
        attempt: globalAttemptNumber,
        sessionIndex,
        startedAt: attemptStartedAt,
        endedAt: attemptEndedAt,
        prompt: currentPrompt,
        sessionIdAtStart,
        sessionIdCaptured: invokeResult.sessionId,
        exitCode: invokeResult.exitCode,
        signal: invokeResult.signal,
        timedOut: invokeResult.timedOut,
        transcript: invokeResult.transcript,
        logPath,
        tasksAfter: manifest.finalTasks,
        invalidStatuses: mergeInfo.invalidStatuses,
      };
      manifest.attemptRecords.push(attemptRecord);
      manifest.attempts = manifest.attemptRecords.length;

      if (sessionRecord.firstAttempt === null) {
        sessionRecord.firstAttempt = globalAttemptNumber;
      }
      sessionRecord.lastAttempt = globalAttemptNumber;

      tryRefreshMutableManifestName(manifest);
      writeManifest(workspaceDir, manifest);
    });

    if (invokeResult.aborted) {
      terminal = { status: "aborted", exitCode: 130 };
      emitEvent({ type: "run_aborted" });
      break;
    }

    if (resumeRejected) {
      terminal = { status: "error", exitCode: 4 };
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

    currentPrompt = buildNudgeMessage(tasks, mergeInfo.invalidStatuses, runId);
  }

  if (!terminal) {
    terminal = { status: "error", exitCode: 4 };
  }

  let orderedTasks: TaskState[] = [];
  let tasksCompleted = 0;
  const endedAt = new Date().toISOString();
  withTaskStateLock(workspaceDir, () => {
    tasks = refreshManifestTaskState(manifest);
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
    tryRefreshMutableManifestName(manifest);
    writeManifest(workspaceDir, manifest);
  });

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
