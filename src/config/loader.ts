import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import matter from "gray-matter";
import { type AgentConfig, agentConfigSchema } from "./schema.js";

export interface LoadedAgent {
  config: AgentConfig;
  instructions: string;
  sourcePath: string;
}

export class AgentNotFoundError extends Error {
  constructor(
    public readonly arg: string,
    public readonly searched: string[],
  ) {
    super(`Agent not found: ${arg}\n  searched:\n${searched.map((s) => `    - ${s}`).join("\n")}`);
    this.name = "AgentNotFoundError";
  }
}

export class AgentConfigError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly issues: string,
  ) {
    super(`Invalid agent config at ${sourcePath}:\n${issues}`);
    this.name = "AgentConfigError";
  }
}

function taskRunnerHome(): string {
  return process.env.TASK_RUNNER_HOME ?? resolve(homedir(), ".task-runner");
}

function looksLikePath(arg: string): boolean {
  return arg.includes("/") || arg.includes("\\") || arg.startsWith(".");
}

export function resolveAgentPath(arg: string, cwd: string = process.cwd()): string {
  if (looksLikePath(arg)) {
    const abs = isAbsolute(arg) ? arg : resolve(cwd, arg);
    if (!existsSync(abs)) {
      throw new AgentNotFoundError(arg, [abs]);
    }
    return abs;
  }

  const candidates = [
    resolve(cwd, "agents", arg, "agent.md"),
    resolve(taskRunnerHome(), "agents", arg, "agent.md"),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new AgentNotFoundError(arg, candidates);
}

export function loadAgentConfig(arg: string, cwd: string = process.cwd()): LoadedAgent {
  const sourcePath = resolveAgentPath(arg, cwd);
  const raw = readFileSync(sourcePath, "utf8");
  const parsed = matter(raw);
  const result = agentConfigSchema.safeParse(parsed.data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new AgentConfigError(sourcePath, issues);
  }
  return {
    config: result.data,
    instructions: parsed.content.trim(),
    sourcePath,
  };
}
