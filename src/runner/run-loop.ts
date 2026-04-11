import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { mergeIntoFile, mergeUpdates } from "../assignment/merge.js";
import type { TaskState, TaskStatus } from "../assignment/model.js";
import { parseAssignment } from "../assignment/parser.js";
import { renderAssignment } from "../assignment/writer.js";
import type { Backend, BackendInvokeResult } from "../backends/types.js";
import { interpolate } from "../config/interpolate.js";
import type { LoadedAgent } from "../config/loader.js";
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
  cliVars: Record<string, string>;
  backend: Backend;
  overrides?: RunOverrides;
  resume?: ResolvedResumeTarget;
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
        "  the agent has no instructions body, no `message` (frontmatter or\n" +
        "  CLI positional), and no tasks. At least one is required. Add\n" +
        "  instructions to the agent.md body, pass a positional message, or\n" +
        "  add tasks via `tasks:` in frontmatter or `--add-task`.",
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
    super(`cannot override locked field: ${field}\n  this agent fixes it to ${valStr}`);
    this.name = "LockedFieldError";
  }
}

function checkLockedFields(
  config: LoadedAgent["config"],
  overrides: RunOverrides | undefined,
): void {
  if (!overrides || config.lockedFields.length === 0) return;
  const locked = new Set<LockableField>(config.lockedFields);
  const overrideEntries: [LockableField, unknown][] = [
    ["cwd", overrides.cwd],
    ["model", overrides.model],
    ["effort", overrides.effort],
    ["message", overrides.message],
    ["timeoutSec", overrides.timeoutSec],
    ["unrestricted", overrides.unrestricted],
    ["maxRetries", overrides.maxRetries],
    [
      "tasks",
      overrides.addedTasks && overrides.addedTasks.length > 0 ? overrides.addedTasks : undefined,
    ],
  ];
  for (const [key, value] of overrideEntries) {
    if (value !== undefined && locked.has(key)) {
      const currentValue = (config as Record<string, unknown>)[key];
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
  loaded: LoadedAgent,
  cliVars: Record<string, string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, def] of Object.entries(loaded.config.vars)) {
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

function rebuildTasksFromSnapshot(
  config: LoadedAgent["config"],
  snapshot: Record<string, TaskSnapshot>,
  normalize: boolean,
): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  for (const t of config.tasks) {
    const prior = snapshot[t.id];
    tasks.set(t.id, {
      id: t.id,
      title: t.title,
      body: t.body ?? "",
      status: prior ? (normalize ? normalizeResumeStatus(prior.status) : prior.status) : "pending",
      notes: prior?.notes ?? "",
    });
  }
  return tasks;
}

export async function runAgent(opts: RunOptions): Promise<RunOutcome> {
  const { loaded, cliVars, backend, overrides, resume, stderr, stdout } = opts;
  const config = loaded.config;
  const resumeFailureDetector = opts.resumeFailureDetector ?? defaultResumeFailureDetector;

  checkLockedFields(config, overrides);

  const isResume = Boolean(resume);
  const baseDir = process.cwd();
  const cwd = resolveCwd(overrides?.cwd ?? config.cwd, baseDir);
  const model = overrides?.model ?? config.model;
  const effort = overrides?.effort ?? config.effort;
  const message = overrides?.message ?? config.message ?? null;
  const timeoutSec = overrides?.timeoutSec ?? config.timeoutSec;
  const unrestricted = overrides?.unrestricted ?? config.unrestricted;
  const maxRetries = overrides?.maxRetries ?? config.maxRetries;
  const maxAttempts = maxRetries + 1;

  if (isResume) {
    if (!message || message.trim().length === 0) {
      throw new ResumeError("resuming a run requires a follow-up message");
    }
    if (!resume?.manifest.backendSessionId) {
      throw new ResumeError(
        `cannot resume run ${resume?.manifest.runId ?? "<unknown>"} — prior sessions captured no backend session id`,
      );
    }
  }

  const runtimeVars = resolveVars(loaded, cliVars);

  const runId = isResume && resume ? resume.manifest.runId : shortId();
  const workspaceDir =
    isResume && resume ? resume.workspaceDir : resolve(cwd, ".task-runner", runId);
  mkdirSync(workspaceDir, { recursive: true });
  const assignmentPath = resolve(workspaceDir, "assignment.md");

  const priorHadTasks = Boolean(
    isResume && resume && Object.keys(resume.manifest.finalTasks).length > 0,
  );

  const tasks =
    isResume && resume
      ? rebuildTasksFromSnapshot(config, resume.manifest.finalTasks, true)
      : rebuildTasksFromSnapshot(config, {}, false);

  const addedTitles = overrides?.addedTasks ?? [];
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

  const instructionsBody = loaded.instructions.trim();
  const trimmedMessage = message?.trim() ?? "";

  let initialPrompt: string;
  if (isResume) {
    // Resume sessions always have a message (enforced above).
    const parts: string[] = [trimmedMessage];
    if (firstTimeTasksAppear) {
      // Prior sessions had no tasks, so claude's cached session never saw the workflow.
      // Inject it into this follow-up message.
      parts.push(interpolate(TASK_WORKFLOW_TEMPLATE, injectedVars));
    } else if (resumeAddedNewTasks) {
      // Claude already knows the workflow; just nudge it that new tasks appeared.
      parts.push(buildAddedTasksReminder(addedTitles.length, assignmentPath));
    }
    initialPrompt = parts.join("\n\n");
  } else {
    const parts: string[] = [];
    if (trimmedMessage.length > 0) {
      parts.push(trimmedMessage);
    }
    if (instructionsBody.length > 0) {
      parts.push(interpolate(instructionsBody, injectedVars));
    }
    if (hasTasks) {
      parts.push(interpolate(TASK_WORKFLOW_TEMPLATE, injectedVars));
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
  const sessionIndex = priorSessionCount;

  const manifest: RunManifest =
    isResume && resume
      ? {
          ...resume.manifest,
          message: resume.manifest.message,
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
        }
      : {
          schemaVersion: 1,
          runId,
          agent: {
            name: config.name,
            sourcePath: loaded.sourcePath,
          },
          backend: config.backend,
          model: model ?? null,
          effort: effort ?? null,
          message,
          unrestricted,
          cwd,
          assignmentPath,
          workspaceDir,
          startedAt: now,
          endedAt: null,
          status: "running",
          exitCode: null,
          attempts: 0,
          maxAttempts,
          tasksCompleted: 0,
          tasksTotal: tasks.size,
          backendSessionId: null,
          finalTasks: snapshotTasks(tasks),
          sessionCount: 1,
          sessions: [],
          attemptRecords: [],
        };

  const sessionRecord: SessionRecord = {
    sessionIndex,
    startedAt: now,
    endedAt: null,
    status: "running",
    exitCode: null,
    message: isResume ? message : message,
    firstAttempt: null,
    lastAttempt: null,
    maxAttempts,
    backendSessionIdAtStart: isResume && resume ? resume.manifest.backendSessionId : null,
    backendSessionIdAtEnd: null,
  };
  manifest.sessions.push(sessionRecord);

  writeManifest(workspaceDir, manifest);

  stderr(
    `task-runner: agent=${config.name} run=${runId}${isResume ? ` (session ${sessionIndex})` : ""}\n`,
  );
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
      stderr("task-runner: claude rejected the resume session; stopping.\n");
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
