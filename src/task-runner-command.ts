import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";

const FALLBACK_TASK_RUNNER_CMD = "task-runner";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveTaskRunnerCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.TASK_RUNNER_CMD?.trim();
  if (configured) return configured;

  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "task-runner");
    if (isExecutable(candidate)) return candidate;
  }

  return FALLBACK_TASK_RUNNER_CMD;
}
