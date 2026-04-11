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
import { buildNudgeMessage } from "./nudge.js";
import { type RunStatus, type RunSummary, renderSummary } from "./output.js";

export interface RunOverrides {
  cwd?: string;
  model?: string;
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
  attemptMessages: string[];
  runId: string;
  planPath: string;
  workspaceDir: string;
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

export async function runAgent(opts: RunOptions): Promise<RunOutcome> {
  const { loaded, cliVars, backend, extraPrompt, overrides, stderr, stdout } = opts;
  const config = loaded.config;
  const resumeFailureDetector = opts.resumeFailureDetector ?? defaultResumeFailureDetector;

  const baseDir = process.cwd();
  const cwd = resolveCwd(overrides?.cwd ?? config.cwd, baseDir);
  const model = overrides?.model ?? config.model;
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

  stderr(`task-runner: agent=${config.name} run=${runId}\n`);
  stderr(`             plan=${planPath}\n`);
  stderr(`             cwd=${cwd}\n`);
  stderr("\n");

  let attempts = 0;
  let sessionId: string | null = null;
  let currentPrompt = initialPrompt;
  const attemptMessages: string[] = [];
  let terminal: { status: RunStatus; exitCode: number } | null = null;

  while (attempts < maxAttempts && !terminal) {
    attempts++;
    const divider = `── attempt ${attempts} ──\n`;
    stderr(divider);
    stdout(divider);

    const invokeResult = await backend.invoke({
      prompt: currentPrompt,
      cwd,
      env: { ...process.env } as Record<string, string>,
      model,
      unrestricted,
      timeoutSec,
      resumeSessionId: sessionId ?? undefined,
      onStdoutText: (text) => stdout(text),
      onStderrText: (text) => stderr(text),
    });
    stdout("\n");

    if (invokeResult.assistantMessage) {
      attemptMessages.push(invokeResult.assistantMessage);
    }

    if (attempts === 1 && invokeResult.sessionId) {
      sessionId = invokeResult.sessionId;
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

    const allCompleted = Array.from(tasks.values()).every((t) => t.status === "completed");
    const noInvalid = mergeInfo.invalidStatuses.length === 0;
    const blocked = Array.from(tasks.values()).filter((t) => t.status === "blocked");

    if (allCompleted && noInvalid) {
      terminal = { status: "success", exitCode: 0 };
      break;
    }
    if (blocked.length > 0) {
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

    const incompleteCount = Array.from(tasks.values()).filter(
      (t) => t.status !== "completed",
    ).length;
    stderr(
      `\ntask-runner: retrying — ${incompleteCount} incomplete, ${mergeInfo.invalidStatuses.length} invalid status${mergeInfo.invalidStatuses.length === 1 ? "" : "es"}\n\n`,
    );

    currentPrompt = buildNudgeMessage(tasks, mergeInfo.invalidStatuses, planPath);
  }

  if (!terminal) {
    terminal = { status: "error", exitCode: 4 };
  }

  const tasksCompleted = Array.from(tasks.values()).filter((t) => t.status === "completed").length;
  const blockedTasks = Array.from(tasks.values()).filter((t) => t.status === "blocked");
  const incompleteTasks = Array.from(tasks.values()).filter(
    (t) => t.status !== "completed" && t.status !== "blocked",
  );

  const summary: RunSummary = {
    status: terminal.status,
    attempts,
    maxAttempts,
    tasksCompleted,
    tasksTotal: tasks.size,
    planPath,
    blockedTasks,
    incompleteTasks,
  };
  stderr(renderSummary(summary));

  return {
    summary,
    exitCode: terminal.exitCode,
    attemptMessages,
    runId,
    planPath,
    workspaceDir,
  };
}
