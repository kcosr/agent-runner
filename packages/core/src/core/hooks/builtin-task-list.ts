import { TaskListConfigError, loadRepoLocalTaskList } from "../../config/loader.js";
import { defineHook } from "../../hooks.js";
import type { HookResult, PrepareHookContext, ResolvedTask } from "./types.js";

interface TaskListHookConfig {
  path: string;
  mode: "replace";
  missing: "continue";
  empty: "keep-existing";
}

function parseConfig(config: unknown): TaskListHookConfig {
  if (!config || typeof config !== "object" || Array.isArray(config)) {
    throw new Error("task-list hook requires an object config");
  }
  const record = config as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "path" && key !== "mode" && key !== "missing" && key !== "empty") {
      throw new Error(`task-list hook does not support config key "${key}"`);
    }
  }
  if (typeof record.path !== "string" || record.path.trim().length === 0) {
    throw new Error("task-list hook requires string config path");
  }
  if (record.mode !== "replace") {
    throw new Error('task-list hook mode must be "replace"');
  }
  if (record.missing !== "continue") {
    throw new Error('task-list hook missing must be "continue"');
  }
  if (record.empty !== "keep-existing") {
    throw new Error('task-list hook empty must be "keep-existing"');
  }
  return {
    path: record.path,
    mode: record.mode,
    missing: record.missing,
    empty: record.empty,
  };
}

export default defineHook({
  name: "task-list",
  prepare(ctx: PrepareHookContext): HookResult {
    const config = parseConfig(ctx.config);
    let tasks: ResolvedTask[];
    try {
      tasks = loadRepoLocalTaskList(config.path);
    } catch (error) {
      if (isMissingTaskListFile(error)) {
        return { action: "continue" };
      }
      throw error;
    }
    if (tasks.length === 0) {
      return { action: "continue" };
    }
    return {
      action: "continue",
      mutate: {
        setTasks: tasks,
      },
    };
  },
});

function isMissingTaskListFile(error: unknown): boolean {
  const cause = error instanceof TaskListConfigError ? error.cause : undefined;
  return (
    typeof cause === "object" && cause !== null && (cause as { code?: unknown }).code === "ENOENT"
  );
}
