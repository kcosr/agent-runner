import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { defineHook } from "../../hooks.js";
import type {
  AttemptHookContext,
  HookResult,
  PrepareHookContext,
  TaskTransitionHookContext,
  TaskTransitionResult,
} from "./types.js";

const execFileAsync = promisify(execFile);

interface CommandHookConfig {
  mode: "status" | "json";
  command: string;
  args?: string[];
  cwd?: string;
}

function commandConfig(config: unknown): CommandHookConfig {
  if (!config || typeof config !== "object") {
    throw new Error("command hook requires an object config");
  }
  const record = config as Record<string, unknown>;
  const mode = record.mode;
  const command = record.command;
  if ((mode !== "status" && mode !== "json") || typeof command !== "string") {
    throw new Error("command hook requires `mode` and `command`");
  }
  const args = Array.isArray(record.args)
    ? record.args.map((value) => {
        if (typeof value !== "string") {
          throw new Error("command hook args must be strings");
        }
        return value;
      })
    : [];
  return {
    mode,
    command,
    args,
    cwd: typeof record.cwd === "string" ? record.cwd : undefined,
  };
}

async function runCommand(
  config: unknown,
  cwd: string,
): Promise<{
  exitCode: number | null;
  stdout: string;
  stderr: string;
}> {
  const parsed = commandConfig(config);
  try {
    const result = await execFileAsync(parsed.command, parsed.args ?? [], {
      cwd: parsed.cwd ?? cwd,
      encoding: "utf8",
    });
    return {
      exitCode: 0,
      stdout: result.stdout,
      stderr: result.stderr,
    };
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stdout?: string;
      stderr?: string;
      code?: number;
      status?: number;
    };
    const exitCode =
      typeof err.status === "number" ? err.status : typeof err.code === "number" ? err.code : null;
    if (exitCode !== null) {
      return {
        exitCode,
        stdout: err.stdout ?? "",
        stderr: err.stderr ?? "",
      };
    }
    throw error;
  }
}

function parseJsonResult<T>(stdout: string, label: string): T {
  try {
    return JSON.parse(stdout) as T;
  } catch {
    throw new Error(`${label}: malformed JSON output`);
  }
}

async function nonTaskPhase(label: string, config: unknown, cwd: string): Promise<HookResult> {
  const parsed = commandConfig(config);
  const result = await runCommand(config, cwd);
  if (parsed.mode === "json") {
    if (result.exitCode !== 0) {
      throw new Error(`${label}: json mode command exited with code ${result.exitCode}`);
    }
    return parseJsonResult<HookResult>(result.stdout, label);
  }
  if (result.exitCode === 0) {
    return { action: "continue" };
  }
  const reason = result.stderr.trim() || `${label}: command exited with code ${result.exitCode}`;
  return { action: "block", reason };
}

async function taskTransitionPhase(config: unknown, cwd: string): Promise<TaskTransitionResult> {
  const parsed = commandConfig(config);
  const result = await runCommand(config, cwd);
  if (parsed.mode === "json") {
    if (result.exitCode !== 0) {
      throw new Error(`taskTransition command exited with code ${result.exitCode}`);
    }
    return parseJsonResult<TaskTransitionResult>(result.stdout, "taskTransition command");
  }
  if (result.exitCode === 0) {
    return { accept: true };
  }
  const reason =
    result.stderr.trim() || `taskTransition command exited with code ${result.exitCode}`;
  return { accept: false, reason };
}

export default defineHook({
  name: "command",
  prepare(ctx: PrepareHookContext) {
    return nonTaskPhase("prepare command hook", ctx.config, ctx.run.cwd);
  },
  beforeAttempt(ctx: AttemptHookContext) {
    return nonTaskPhase("beforeAttempt command hook", ctx.config, ctx.run.cwd);
  },
  afterAttempt(ctx: AttemptHookContext) {
    return nonTaskPhase("afterAttempt command hook", ctx.config, ctx.run.cwd);
  },
  afterExit(ctx: AttemptHookContext) {
    return nonTaskPhase("afterExit command hook", ctx.config, ctx.run.cwd);
  },
  taskTransition(ctx: TaskTransitionHookContext) {
    return taskTransitionPhase(ctx.config, ctx.run.cwd);
  },
});
