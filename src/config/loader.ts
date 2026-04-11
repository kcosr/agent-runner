import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import matter from "gray-matter";
import {
  type AgentConfig,
  type AssignmentConfig,
  agentConfigSchema,
  assignmentConfigSchema,
} from "./schema.js";

export interface LoadedAgent {
  config: AgentConfig;
  instructions: string;
  sourcePath: string;
}

export interface LoadedAssignment {
  config: AssignmentConfig;
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

export class AssignmentNotFoundError extends Error {
  constructor(
    public readonly arg: string,
    public readonly searched: string[],
  ) {
    super(
      `Assignment not found: ${arg}\n  searched:\n${searched.map((s) => `    - ${s}`).join("\n")}`,
    );
    this.name = "AssignmentNotFoundError";
  }
}

export class AssignmentConfigError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly issues: string,
  ) {
    super(`Invalid assignment config at ${sourcePath}:\n${issues}`);
    this.name = "AssignmentConfigError";
  }
}

function taskRunnerHome(): string {
  return process.env.TASK_RUNNER_HOME ?? resolve(homedir(), ".task-runner");
}

function looksLikePath(arg: string): boolean {
  return arg.includes("/") || arg.includes("\\") || arg.startsWith(".");
}

function resolveDefinitionPath(
  kind: "agent" | "assignment",
  arg: string,
  cwd: string,
): { path: string; searched: string[] } {
  const dirName = kind === "agent" ? "agents" : "assignments";
  const fileName = kind === "agent" ? "agent.md" : "assignment.md";

  if (looksLikePath(arg)) {
    const abs = isAbsolute(arg) ? arg : resolve(cwd, arg);
    return { path: abs, searched: [abs] };
  }

  const candidates = [
    resolve(cwd, dirName, arg, fileName),
    resolve(taskRunnerHome(), dirName, arg, fileName),
  ];
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { path: candidate, searched: candidates };
  }
  return { path: "", searched: candidates };
}

export function resolveAgentPath(arg: string, cwd: string = process.cwd()): string {
  const { path, searched } = resolveDefinitionPath("agent", arg, cwd);
  if (!path || !existsSync(path)) {
    throw new AgentNotFoundError(arg, searched);
  }
  return path;
}

export function resolveAssignmentPath(arg: string, cwd: string = process.cwd()): string {
  const { path, searched } = resolveDefinitionPath("assignment", arg, cwd);
  if (!path || !existsSync(path)) {
    throw new AssignmentNotFoundError(arg, searched);
  }
  return path;
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

export function loadAssignmentConfig(arg: string, cwd: string = process.cwd()): LoadedAssignment {
  const sourcePath = resolveAssignmentPath(arg, cwd);
  const raw = readFileSync(sourcePath, "utf8");
  const parsed = matter(raw);
  const result = assignmentConfigSchema.safeParse(parsed.data);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n");
    throw new AssignmentConfigError(sourcePath, issues);
  }
  return {
    config: result.data,
    instructions: parsed.content.trim(),
    sourcePath,
  };
}
