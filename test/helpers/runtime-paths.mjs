import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolveResumeTarget } from "../../packages/core/dist/core/run/manifest.js";

export function withEnv(overrides, fn) {
  const prior = {};
  for (const key of Object.keys(overrides)) {
    prior[key] = process.env[key];
    if (overrides[key] === undefined) delete process.env[key];
    else process.env[key] = overrides[key];
  }

  const restore = () => {
    for (const [key, value] of Object.entries(prior)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  };

  try {
    const result = fn();
    if (result && typeof result.then === "function") {
      return result.finally(restore);
    }
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

export function makeRuntimeRoots(prefix, options = {}) {
  const rootDir = mkdtempSync(join(process.cwd(), prefix));
  const configDir = options.sharedRoot ? rootDir : join(rootDir, "config");
  const stateDir = options.sharedRoot ? rootDir : join(rootDir, "state");
  mkdirSync(configDir, { recursive: true });
  mkdirSync(stateDir, { recursive: true });

  function cleanup() {
    rmSync(rootDir, { recursive: true, force: true });
  }

  return {
    rootDir,
    configDir,
    stateDir,
    env: {
      TASK_RUNNER_CONFIG_DIR: configDir,
      TASK_RUNNER_STATE_DIR: stateDir,
      TASK_RUNNER_CMD: "task-runner",
    },
    cleanup,
  };
}

export function withRuntimeRoots(prefix, fn, options = {}) {
  const { rootDir, configDir, stateDir, env, cleanup } = makeRuntimeRoots(prefix, options);

  try {
    const result = withEnv(env, () => fn({ rootDir, configDir, stateDir }));
    if (result && typeof result.then === "function") {
      return result.finally(cleanup);
    }
    cleanup();
    return result;
  } catch (error) {
    cleanup();
    throw error;
  }
}

export function sharedRuntimeEnv(baseDir) {
  return {
    TASK_RUNNER_CONFIG_DIR: baseDir,
    TASK_RUNNER_STATE_DIR: baseDir,
    TASK_RUNNER_CMD: "task-runner",
    TASK_RUNNER_CONNECT: undefined,
    TASK_RUNNER_LISTEN: undefined,
    TASK_RUNNER_PARENT_RUN_ID: undefined,
    TASK_RUNNER_DEBUG_PERF: undefined,
    TASK_RUNNER_DEBUG_PERF_INTERVAL_MS: undefined,
  };
}

export function withSharedRuntimeEnv(baseDir, fn) {
  return withEnv(sharedRuntimeEnv(baseDir), fn);
}

export function runIdFromPrompt(prompt) {
  const patterns = [
    /run id is [`"]?([A-Za-z0-9._:-]+)[`"]?/,
    /task list ([A-Za-z0-9._:-]+)/,
    /task show ([A-Za-z0-9._:-]+)/,
    /task set ([A-Za-z0-9._:-]+)/,
    /task append-notes ([A-Za-z0-9._:-]+)/,
    /status ([A-Za-z0-9._:-]+)/,
  ];
  for (const pattern of patterns) {
    const match = prompt.match(pattern);
    if (match) {
      return match[1];
    }
  }
  throw new Error(`run id not found in prompt: ${prompt}`);
}

export function resolveRunFromPrompt(prompt, cwd = process.cwd()) {
  return resolveResumeTarget(runIdFromPrompt(prompt), cwd);
}

export function readManifestForPrompt(prompt, cwd = process.cwd()) {
  const resolved = resolveRunFromPrompt(prompt, cwd);
  return JSON.parse(readFileSync(join(resolved.workspaceDir, "run.json"), "utf8"));
}

export function writeManifestForPrompt(prompt, manifest, cwd = process.cwd()) {
  const resolved = resolveRunFromPrompt(prompt, cwd);
  writeFileSync(join(resolved.workspaceDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return resolved;
}

export function patchManifestForPrompt(prompt, mutator, cwd = process.cwd()) {
  const manifest = readManifestForPrompt(prompt, cwd);
  mutator(manifest);
  writeManifestForPrompt(prompt, manifest, cwd);
  return manifest;
}

export function patchTasksForPrompt(prompt, mutator, cwd = process.cwd()) {
  return patchManifestForPrompt(
    prompt,
    (manifest) => {
      mutator(manifest.finalTasks);
      manifest.tasksTotal = Object.keys(manifest.finalTasks).length;
      manifest.tasksCompleted = Object.values(manifest.finalTasks).filter(
        (task) => task.status === "completed",
      ).length;
    },
    cwd,
  );
}

export function setTaskStatusesForPrompt(prompt, updates, cwd = process.cwd()) {
  return patchTasksForPrompt(
    prompt,
    (tasks) => {
      for (const [taskId, status] of Object.entries(updates)) {
        tasks[taskId].status = status;
      }
    },
    cwd,
  );
}

export function updateTasksForPrompt(prompt, updates, cwd = process.cwd()) {
  return patchTasksForPrompt(
    prompt,
    (tasks) => {
      for (const [taskId, patch] of Object.entries(updates)) {
        Object.assign(tasks[taskId], patch);
      }
    },
    cwd,
  );
}

export function completeAllTasksFromPrompt(prompt, cwd = process.cwd()) {
  return patchTasksForPrompt(
    prompt,
    (tasks) => {
      for (const task of Object.values(tasks)) {
        task.status = "completed";
      }
    },
    cwd,
  );
}

export function assignmentPathFromPrompt(prompt) {
  const match = prompt.match(/\/\S+?\/assignment\.md/);
  if (!match) {
    throw new Error(`assignment.md path not found in prompt: ${prompt}`);
  }
  return match[0];
}
