import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { mergeIntoFile, mergeUpdates } from "../assignment/merge.js";
import type { TaskState, TaskStatus } from "../assignment/model.js";
import { parseAssignment } from "../assignment/parser.js";
import { renderAssignment } from "../assignment/writer.js";
import type { Backend, BackendInvokeResult } from "../backends/types.js";
import { interpolate } from "../config/interpolate.js";
import type { LoadedAgent, LoadedAssignment } from "../config/loader.js";
import type { LockableField, VarDef } from "../config/schema.js";
import { shortId } from "../util/short-id.js";
import {
  type AttemptRecord,
  type ResolvedResumeTarget,
  ResumeError,
  type RunManifest,
  type SessionRecord,
  type TaskSnapshot,
  snapshotTasks,
  writeAttemptLog,
  writeManifest,
} from "./manifest.js";
import { buildNudgeMessage } from "./nudge.js";
import { type RunStatus, type RunSummary, renderSummary } from "./output.js";
import { TASK_WORKFLOW_TEMPLATE, buildAddedTasksReminder } from "./task-workflow.js";

export interface RunOverrides {
  cwd?: string;
  model?: string;
  effort?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  message?: string;
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
  overrides?: RunOverrides;
  resume?: ResolvedResumeTarget;
  initialize?: boolean;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
  resumeFailureDetector?: (result: BackendInvokeResult) => boolean;
}

export interface RunOutcome {
  summary: RunSummary;
  exitCode: number;
  attemptTranscripts: string[];
  runId: string;
  assignmentPath: string;
  workspaceDir: string;
  manifest: RunManifest;
}

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
    ["model", overrides?.model, agentConfig.model],
    ["effort", overrides?.effort, agentConfig.effort],
    ["message", overrides?.message, assignmentConfig?.message],
    ["timeoutSec", overrides?.timeoutSec, agentConfig.timeoutSec],
    ["unrestricted", overrides?.unrestricted, agentConfig.unrestricted],
    ["maxRetries", overrides?.maxRetries, agentConfig.maxRetries],
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

function resolveCwd(input: string | undefined, fallback: string): string {
  if (!input || input === ".") return fallback;
  return isAbsolute(input) ? input : resolve(fallback, input);
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

function resolveVars(
  varsSchema: Record<string, VarDef>,
  cliVars: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(varsSchema)) {
    let value: unknown;

    if (def.source === "cli" || def.source === "either") {
      if (cliVars[key] !== undefined) value = cliVars[key];
    }
    if (value === undefined && (def.source === "env" || def.source === "either")) {
      const envName = def.envName ?? key;
      const envValue = process.env[envName];
      if (envValue !== undefined) value = envValue;
    }
    if (value === undefined && def.default !== undefined) {
      value = def.default;
    }
    if (value === undefined) {
      if (def.required) {
        throw new VarResolutionError(`missing required var: ${key}`);
      }
      continue;
    }

    out[key] = coerceVar(key, value, def);
  }
  return out;
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
): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  const source = assignment?.config.tasks ?? [];
  for (const t of source) {
    const prior = snapshot[t.id];
    tasks.set(t.id, {
      id: t.id,
      title: t.title,
      body: t.body ?? "",
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

export async function runAgent(opts: RunOptions): Promise<RunOutcome> {
  const { loaded, loadedAssignment, cliVars, backend, overrides, resume, stderr, stdout } = opts;
  const agentConfig = loaded.config;
  const assignmentConfig = loadedAssignment?.config;
  const resumeFailureDetector = opts.resumeFailureDetector ?? defaultResumeFailureDetector;

  const isInitialize = opts.initialize === true;
  const priorInitialized = resume?.manifest.status === "initialized";
  const isResume = Boolean(resume) && !priorInitialized;

  if (isInitialize && resume) {
    throw new ResumeError("--init cannot be combined with --resume-run");
  }
  if (isResume && loadedAssignment) {
    throw new ResumeError("--assignment cannot be combined with --resume-run");
  }
  if (priorInitialized && loadedAssignment) {
    throw new ResumeError("--assignment cannot be combined with resuming an initialized run");
  }
  if (priorInitialized && (overrides?.addedTasks?.length ?? 0) > 0) {
    throw new ResumeError("--add-task cannot be combined with resuming an initialized run");
  }

  const addedTitles = overrides?.addedTasks ?? [];
  const agentInstructions = loaded.instructions.trim();
  const assignmentInstructions = loadedAssignment?.instructions.trim() ?? "";

  if (!priorInitialized) {
    checkLockedFields(
      agentConfig,
      assignmentConfig,
      agentInstructions,
      assignmentInstructions,
      overrides,
      addedTitles,
    );
  }

  const baseDir = process.cwd();
  const cwd = resolveCwd(overrides?.cwd ?? agentConfig.cwd, baseDir);
  const model = overrides?.model ?? agentConfig.model;
  const effort = overrides?.effort ?? agentConfig.effort;
  const message = overrides?.message ?? assignmentConfig?.message ?? null;
  const timeoutSec = overrides?.timeoutSec ?? agentConfig.timeoutSec;
  const unrestricted = overrides?.unrestricted ?? agentConfig.unrestricted;
  const maxRetries = overrides?.maxRetries ?? agentConfig.maxRetries;
  const maxAttempts = maxRetries + 1;

  if (isResume) {
    const hasMessage = Boolean(message && message.trim().length > 0);
    const hasAddedTasks = addedTitles.length > 0;
    if (!hasMessage && !hasAddedTasks) {
      throw new ResumeError(
        "resuming a run requires either a follow-up message or at least one --add-task",
      );
    }
    if (!resume?.manifest.backendSessionId) {
      throw new ResumeError(
        `cannot resume run ${resume?.manifest.runId ?? "<unknown>"} — prior sessions captured no backend session id`,
      );
    }
  }

  // `priorInitialized` short-circuits most of the fresh-run setup below
  // because the workspace and prompt were already persisted by the earlier
  // `init`. We reuse the runId + workspace and use the stored prompt
  // verbatim for session 0's first attempt.

  // Vars live on the assignment. Chat mode (no assignment) has no var
  // schema; unknown --var flags are silently ignored in that case.
  const runtimeVars = resolveVars(assignmentConfig?.vars ?? {}, cliVars);

  const reusingWorkspace = (isResume && resume) || (priorInitialized && resume);
  const runId = reusingWorkspace && resume ? resume.manifest.runId : shortId();
  const workspaceDir =
    reusingWorkspace && resume ? resume.workspaceDir : resolve(cwd, ".task-runner", runId);
  mkdirSync(workspaceDir, { recursive: true });
  const assignmentPath = resolve(workspaceDir, "assignment.md");

  const priorHadTasks = Boolean(
    isResume && resume && Object.keys(resume.manifest.finalTasks).length > 0,
  );

  let tasks: Map<string, TaskState>;
  if (isResume && resume) {
    tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, resume.manifest.finalTasks, true);
  } else if (priorInitialized && resume) {
    tasks = rebuildTasksFromAssignmentAndSnapshot(undefined, resume.manifest.finalTasks, false);
  } else {
    tasks = rebuildTasksFromAssignmentAndSnapshot(loadedAssignment, {}, false);
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

  const injectedVars: Record<string, unknown> = {
    ...runtimeVars,
    assignment_path: assignmentPath,
    run_id: runId,
    cwd,
  };

  const trimmedMessage = message?.trim() ?? "";

  // Prompt composition (Option B: broad → specific → mechanics → ask).
  //
  // Fresh run parts (non-empty only, joined with `\n\n`):
  //   1. agent instructions (role)
  //   2. assignment instructions (work context)
  //   3. task workflow (mechanics, if tasks exist)
  //   4. message (specific ask)
  //
  // Resume follow-up parts:
  //   1. workflow (only if firstTimeTasksAppear) OR new-tasks reminder
  //   2. message
  //
  // Execute-after-init: reuse the stored pendingPrompt verbatim.
  //
  // Both message-last. Fresh runs error if parts is empty.
  let initialPrompt: string;
  if (priorInitialized && resume) {
    const stored = resume.manifest.pendingPrompt ?? "";
    if (stored.length === 0) {
      throw new ResumeError(
        `cannot resume initialized run ${resume.manifest.runId} — manifest has no pendingPrompt`,
      );
    }
    initialPrompt = stored;
  } else if (isResume) {
    const parts: string[] = [];
    if (firstTimeTasksAppear) {
      parts.push(interpolate(TASK_WORKFLOW_TEMPLATE, injectedVars));
    } else if (resumeAddedNewTasks) {
      parts.push(buildAddedTasksReminder(addedTitles.length, assignmentPath));
    }
    if (trimmedMessage.length > 0) {
      parts.push(trimmedMessage);
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
      parts.push(interpolate(TASK_WORKFLOW_TEMPLATE, injectedVars));
    }
    if (trimmedMessage.length > 0) {
      parts.push(trimmedMessage);
    }
    if (parts.length === 0) {
      throw new EmptyPromptError();
    }
    initialPrompt = parts.join("\n\n");
  }

  writeFileSync(assignmentPath, renderAssignment(Array.from(tasks.values())), "utf8");

  const now = new Date().toISOString();
  const priorAttemptCount = isResume && resume ? resume.manifest.attemptRecords.length : 0;
  const priorSessionCount = isResume && resume ? resume.manifest.sessions.length : 0;
  // `priorInitialized` runs start at session 0 — init never created a session.
  const sessionIndex = priorInitialized ? 0 : priorSessionCount;

  let manifest: RunManifest;
  if (isResume && resume) {
    manifest = {
      ...resume.manifest,
      model: model ?? null,
      effort: effort ?? null,
      unrestricted,
      cwd,
      assignmentPath,
      workspaceDir,
      endedAt: null,
      status: "running",
      exitCode: null,
      maxAttempts,
      finalTasks: snapshotTasks(tasks),
      tasksCompleted: countBy(tasks, (t) => t.status === "completed"),
      tasksTotal: tasks.size,
      sessionCount: priorSessionCount + 1,
    };
  } else if (priorInitialized && resume) {
    // Execute-after-init: the manifest was persisted by `init`. Flip it
    // to "running", promote sessionCount to 1, and clear pendingPrompt
    // (it has now been consumed by this first real session).
    manifest = {
      ...resume.manifest,
      endedAt: null,
      status: "running",
      exitCode: null,
      sessionCount: 1,
      pendingPrompt: null,
    };
  } else {
    manifest = {
      schemaVersion: 1,
      runId,
      agent: {
        name: agentConfig.name,
        sourcePath: loaded.sourcePath,
      },
      assignment: loadedAssignment
        ? {
            name: loadedAssignment.config.name,
            sourcePath: loadedAssignment.sourcePath,
            workspacePath: assignmentPath,
          }
        : null,
      backend: agentConfig.backend,
      model: model ?? null,
      effort: effort ?? null,
      message,
      unrestricted,
      cwd,
      assignmentPath,
      workspaceDir,
      startedAt: now,
      endedAt: null,
      status: isInitialize ? "initialized" : "running",
      exitCode: null,
      attempts: 0,
      maxAttempts,
      tasksCompleted: 0,
      tasksTotal: tasks.size,
      backendSessionId: null,
      runtimeVars,
      pendingPrompt: isInitialize ? initialPrompt : null,
      finalTasks: snapshotTasks(tasks),
      sessionCount: isInitialize ? 0 : 1,
      sessions: [],
      attemptRecords: [],
    };
  }

  // `init` stops here: persist the prepared workspace + manifest and
  // return a terminal "initialized" outcome. No session is created; the
  // caller will follow up with `task-runner run --resume-run <id>`.
  if (isInitialize) {
    writeManifest(workspaceDir, manifest);
    stderr(`task-runner: initialized agent=${agentConfig.name} run=${runId}\n`);
    if (loadedAssignment) {
      stderr(`             source=${loadedAssignment.sourcePath}\n`);
    }
    stderr(`             assignment=${assignmentPath}\n`);
    stderr(`             cwd=${cwd}\n`);
    stderr(`             resume with: task-runner run --resume-run ${runId}\n`);
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

  const sessionRecord: SessionRecord = {
    sessionIndex,
    startedAt: now,
    endedAt: null,
    status: "running",
    exitCode: null,
    message: priorInitialized && resume ? resume.manifest.message : message,
    firstAttempt: null,
    lastAttempt: null,
    maxAttempts,
    backendSessionIdAtStart: isResume && resume ? resume.manifest.backendSessionId : null,
    backendSessionIdAtEnd: null,
  };
  manifest.sessions.push(sessionRecord);

  writeManifest(workspaceDir, manifest);

  const sessionSuffix = isResume ? ` (session ${sessionIndex})` : "";
  stderr(`task-runner: agent=${agentConfig.name} run=${runId}${sessionSuffix}\n`);
  if (loadedAssignment) {
    stderr(`             source=${loadedAssignment.sourcePath}\n`);
  }
  stderr(`             assignment=${assignmentPath}\n`);
  stderr(`             cwd=${cwd}\n`);
  stderr("\n");

  let sessionAttempts = 0;
  let sessionId: string | null = isResume && resume ? resume.manifest.backendSessionId : null;
  let currentPrompt = initialPrompt;
  const attemptTranscripts: string[] = [];
  let terminal: { status: RunStatus; exitCode: number } | null = null;

  while (sessionAttempts < maxAttempts && !terminal) {
    sessionAttempts++;
    const globalAttemptNumber = priorAttemptCount + sessionAttempts;
    stderr(`── attempt ${globalAttemptNumber} ──\n`);

    const sessionIdAtStart = sessionId;
    const attemptStartedAt = new Date().toISOString();

    const invokeResult = await backend.invoke({
      prompt: currentPrompt,
      cwd,
      env: { ...process.env } as Record<string, string>,
      model,
      effort,
      unrestricted,
      timeoutSec,
      resumeSessionId: sessionId ?? undefined,
      onStdoutText: (text) => stdout(text),
      onStderrText: (text) => stderr(text),
    });
    stdout("\n");
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

    let rawAssignment: string;
    try {
      rawAssignment = readFileSync(assignmentPath, "utf8");
    } catch {
      rawAssignment = "";
    }

    if (rawAssignment.trim().length === 0) {
      rawAssignment = renderAssignment(Array.from(tasks.values()));
      writeFileSync(assignmentPath, rawAssignment, "utf8");
    }

    const updates = parseAssignment(rawAssignment);
    const mergeInfo = mergeUpdates(tasks, updates);

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
      tasksAfter: snapshotTasks(tasks),
      invalidStatuses: mergeInfo.invalidStatuses,
    };
    manifest.attemptRecords.push(attemptRecord);
    manifest.attempts = manifest.attemptRecords.length;
    manifest.tasksCompleted = countBy(tasks, (t) => t.status === "completed");
    manifest.finalTasks = snapshotTasks(tasks);

    if (sessionRecord.firstAttempt === null) {
      sessionRecord.firstAttempt = globalAttemptNumber;
    }
    sessionRecord.lastAttempt = globalAttemptNumber;

    writeManifest(workspaceDir, manifest);

    if (resumeRejected) {
      terminal = { status: "error", exitCode: 4 };
      stderr("task-runner: backend rejected the resume session; stopping.\n");
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

    const merged = mergeIntoFile(rawAssignment, tasks);
    if (merged !== rawAssignment) {
      writeFileSync(assignmentPath, merged, "utf8");
    }

    const incompleteCount = countBy(tasks, (t) => t.status !== "completed");
    stderr(
      `\ntask-runner: retrying — ${incompleteCount} incomplete, ${mergeInfo.invalidStatuses.length} invalid status${mergeInfo.invalidStatuses.length === 1 ? "" : "es"}\n\n`,
    );

    currentPrompt = buildNudgeMessage(tasks, mergeInfo.invalidStatuses, assignmentPath);
  }

  if (!terminal) {
    terminal = { status: "error", exitCode: 4 };
  }

  const tasksCompleted = countBy(tasks, (t) => t.status === "completed");
  const endedAt = new Date().toISOString();

  sessionRecord.status = terminal.status;
  sessionRecord.exitCode = terminal.exitCode;
  sessionRecord.endedAt = endedAt;
  sessionRecord.backendSessionIdAtEnd = manifest.backendSessionId;

  manifest.status = terminal.status;
  manifest.exitCode = terminal.exitCode;
  manifest.endedAt = endedAt;
  manifest.tasksCompleted = tasksCompleted;
  manifest.finalTasks = snapshotTasks(tasks);
  writeManifest(workspaceDir, manifest);

  const summary: RunSummary = {
    status: terminal.status,
    attempts: sessionAttempts,
    maxAttempts,
    tasksCompleted,
    tasksTotal: tasks.size,
    assignmentPath,
    tasks: Array.from(tasks.values()),
    runId,
  };
  stderr(renderSummary(summary));

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
