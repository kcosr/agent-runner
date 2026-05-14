import { constants, accessSync } from "node:fs";
import { delimiter, join } from "node:path";

const FALLBACK_AGENT_RUNNER_CMD = "agent-runner";

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

export function resolveAgentRunnerCommand(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENT_RUNNER_CMD?.trim();
  if (configured) return configured;

  const pathEnv = env.PATH ?? "";
  for (const dir of pathEnv.split(delimiter)) {
    if (dir.length === 0) continue;
    const candidate = join(dir, "agent-runner");
    if (isExecutable(candidate)) return candidate;
  }

  return FALLBACK_AGENT_RUNNER_CMD;
}
