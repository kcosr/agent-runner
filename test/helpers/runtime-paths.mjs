import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

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
  };
}

export function withSharedRuntimeEnv(baseDir, fn) {
  return withEnv(sharedRuntimeEnv(baseDir), fn);
}

export function assignmentPathFromPrompt(prompt) {
  const match = prompt.match(/\/\S+?\/assignment\.md/);
  if (!match) {
    throw new Error(`assignment.md path not found in prompt: ${prompt}`);
  }
  return match[0];
}
