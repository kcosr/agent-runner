import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { Backend, BackendInvokeResult } from "../backends/types.js";
import { interpolate } from "../config/interpolate.js";
import type { LoadedAgent } from "../config/loader.js";
import type { VarDef } from "../config/schema.js";
import { mergeIntoFile, mergeUpdates } from "../plan/merge.js";
import type { TaskState } from "../plan/model.js";
import { parsePlan } from "../plan/parser.js";
import { renderPlan } from "../plan/writer.js";
import { shortId } from "../util/short-id.js";
import {
  type AttemptRecord,
  type RunManifest,
  snapshotTasks,
  writeAttemptLog,
  writeManifest,
} from "./manifest.js";
import { buildNudgeMessage } from "./nudge.js";
import { type RunStatus, type RunSummary, renderSummary } from "./output.js";

export interface RunOverrides {
  cwd?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "max";
  timeoutSec?: number;
  unrestricted?: boolean;
  maxRetries?: number;
}

export interface RunOptions {
  loaded: LoadedAgent;
  cliVars: Record<string, string>;
  backend: Backend;
  extraPrompt?: string;
  overrides?: RunOverrides;
  stderr: (text: string) => void;
  stdout: (text: string) => void;
  resumeFailureDetector?: (result: BackendInvokeResult) => boolean;
}

export interface RunOutcome {
  summary: RunSummary;
  exitCode: number;
  attemptTranscripts: string[];
  runId: string;
  planPath: string;
  workspaceDir: string;
  manifest: RunManifest;
}

export class VarResolutionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VarResolutionError";
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

export async function runAgent(opts: RunOptions): Promise<RunOutcome> {
  const { loaded, cliVars, backend, extraPrompt, overrides, stderr, stdout } = opts;
  const config = loaded.config;
  const resumeFailureDetector = opts.resumeFailureDetector ?? defaultResumeFailureDetector;

  const baseDir = process.cwd();
  const cwd = resolveCwd(overrides?.cwd ?? config.cwd, baseDir);
  const model = overrides?.model ?? config.model;
  const effort = overrides?.effort ?? config.effort;
  const timeoutSec = overrides?.timeoutSec ?? config.timeoutSec;
  const unrestricted = overrides?.unrestricted ?? config.unrestricted;
  const maxRetries = overrides?.maxRetries ?? config.maxRetries;
  const maxAttempts = maxRetries + 1;

  const runtimeVars = resolveVars(loaded, cliVars);

  const runId = shortId();
  const workspaceDir = resolve(cwd, ".task-runner", runId);
  mkdirSync(workspaceDir, { recursive: true });
  const planPath = resolve(workspaceDir, "tasks.md");

  const tasks = new Map<string, TaskState>();
  for (const t of config.tasks) {
    tasks.set(t.id, {
      id: t.id,
      title: t.title,
      body: t.body ?? "",
      status: "pending",
      notes: "",
    });
  }

  const injectedVars: Record<string, unknown> = {
    ...runtimeVars,
    plan_path: planPath,
    run_id: runId,
    cwd,
  };
  const basePrompt = interpolate(loaded.instructions, injectedVars);
  const initialPrompt = extraPrompt ? `${basePrompt}\n\n${extraPrompt}` : basePrompt;

  writeFileSync(planPath, renderPlan(Array.from(tasks.values())), "utf8");

  const startedAt = new Date().toISOString();
  const manifest: RunManifest = {
    schemaVersion: 1,
    runId,
    agent: {
      name: config.name,
      sourcePath: loaded.sourcePath,
    },
    backend: config.backend,
    model: model ?? null,
    effort: effort ?? null,
    unrestricted,
    cwd,
    planPath,
    workspaceDir,
    startedAt,
    endedAt: null,
    status: "running",
    exitCode: null,
    attempts: 0,
    maxAttempts,
    tasksCompleted: 0,
    tasksTotal: tasks.size,
    backendSessionId: null,
    finalTasks: snapshotTasks(tasks),
    attemptRecords: [],
  };
  writeManifest(workspaceDir, manifest);

  stderr(`task-runner: agent=${config.name} run=${runId}\n`);
  stderr(`             plan=${planPath}\n`);
  stderr(`             cwd=${cwd}\n`);
  stderr("\n");

  let attempts = 0;
  let sessionId: string | null = null;
  let currentPrompt = initialPrompt;
  const attemptTranscripts: string[] = [];
  let terminal: { status: RunStatus; exitCode: number } | null = null;

  while (attempts < maxAttempts && !terminal) {
    attempts++;
    stderr(`── attempt ${attempts} ──\n`);

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

    if (attempts === 1 && invokeResult.sessionId) {
      sessionId = invokeResult.sessionId;
      manifest.backendSessionId = invokeResult.sessionId;
    } else if (sessionId && resumeFailureDetector(invokeResult)) {
      stderr("task-runner: resume failed, falling back to fresh invocation\n");
      sessionId = null;
    }

    let rawPlan: string;
    try {
      rawPlan = readFileSync(planPath, "utf8");
    } catch {
      rawPlan = "";
    }

    if (rawPlan.trim().length === 0) {
      rawPlan = renderPlan(Array.from(tasks.values()));
      writeFileSync(planPath, rawPlan, "utf8");
    }

    const updates = parsePlan(rawPlan);
    const mergeInfo = mergeUpdates(tasks, updates);

    const logPath = writeAttemptLog(workspaceDir, {
      schemaVersion: 1,
      runId,
      attempt: attempts,
      startedAt: attemptStartedAt,
      endedAt: attemptEndedAt,
      stdout: invokeResult.rawStdout,
      stderr: invokeResult.rawStderr,
    });

    const attemptRecord: AttemptRecord = {
      attempt: attempts,
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
    manifest.attempts = attempts;
    manifest.tasksCompleted = countBy(tasks, (t) => t.status === "completed");
    manifest.finalTasks = snapshotTasks(tasks);
    writeManifest(workspaceDir, manifest);

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
    if (attempts >= maxAttempts) {
      terminal = { status: "exhausted", exitCode: 1 };
      break;
    }

    const merged = mergeIntoFile(rawPlan, tasks);
    if (merged !== rawPlan) {
      writeFileSync(planPath, merged, "utf8");
    }

    const incompleteCount = countBy(tasks, (t) => t.status !== "completed");
    stderr(
      `\ntask-runner: retrying — ${incompleteCount} incomplete, ${mergeInfo.invalidStatuses.length} invalid status${mergeInfo.invalidStatuses.length === 1 ? "" : "es"}\n\n`,
    );

    currentPrompt = buildNudgeMessage(tasks, mergeInfo.invalidStatuses, planPath);
  }

  if (!terminal) {
    terminal = { status: "error", exitCode: 4 };
  }

  const tasksCompleted = countBy(tasks, (t) => t.status === "completed");

  manifest.status = terminal.status;
  manifest.exitCode = terminal.exitCode;
  manifest.endedAt = new Date().toISOString();
  manifest.tasksCompleted = tasksCompleted;
  manifest.finalTasks = snapshotTasks(tasks);
  writeManifest(workspaceDir, manifest);

  const summary: RunSummary = {
    status: terminal.status,
    attempts,
    maxAttempts,
    tasksCompleted,
    tasksTotal: tasks.size,
    planPath,
    tasks: Array.from(tasks.values()),
  };
  stderr(renderSummary(summary));

  return {
    summary,
    exitCode: terminal.exitCode,
    attemptTranscripts,
    runId,
    planPath,
    workspaceDir,
    manifest,
  };
}
