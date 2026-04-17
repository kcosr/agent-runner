import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import matter from "gray-matter";
import { AD_HOC_AGENT_NAME } from "../core/config/loaded.js";
import type { LoadedAgent, LoadedAssignment } from "../core/config/loaded.js";
import {
  type AgentConfig,
  type AssignmentConfig,
  agentConfigSchema,
  assignmentConfigSchema,
} from "../core/config/schema.js";
import {
  definitionLayout,
  isPathArg,
  resolveDefinitionRoot,
  resolveInputPath,
} from "./runtime-paths.js";

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

function resolveDefinitionPath(
  kind: "agent" | "assignment",
  arg: string,
  cwd: string,
): { path: string; searched: string[] } {
  const { fileName } = definitionLayout(kind);

  if (isPathArg(arg)) {
    const abs = resolveInputPath(arg, cwd);
    return { path: abs, searched: [abs] };
  }

  const candidate = resolve(resolveDefinitionRoot(kind), arg, fileName);
  return {
    path: existsSync(candidate) ? candidate : "",
    searched: [candidate],
  };
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
  // Reserved name: an on-disk agent cannot declare itself as "ad-hoc".
  // The synthesized CLI path uses this name, and letting a file claim
  // it would produce ambiguous manifests.
  if (result.data.name === AD_HOC_AGENT_NAME) {
    throw new AgentConfigError(
      sourcePath,
      `  - name: "${AD_HOC_AGENT_NAME}" is reserved for CLI-synthesized ad-hoc agents. Please rename.`,
    );
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

// ─────────────────────────────────────────────────────────────────────────────
// Definition catalog — enumerate available definitions from the
// TASK_RUNNER_CONFIG_DIR / XDG config root. Used by `list` and `show`.
// ─────────────────────────────────────────────────────────────────────────────

export type DefinitionKind = "agent" | "assignment";

export interface DefinitionEntry {
  name: string;
  path: string;
  root: "config";
}

export class DefinitionListError extends Error {
  constructor(
    public readonly dir: string,
    cause: unknown,
  ) {
    const msg = cause instanceof Error ? cause.message : String(cause);
    super(`Failed to read definition directory ${dir}: ${msg}`);
    this.name = "DefinitionListError";
  }
}

function discoverDefinitions(kind: DefinitionKind): DefinitionEntry[] {
  const { fileName } = definitionLayout(kind);
  const entries: DefinitionEntry[] = [];
  const dir = resolveDefinitionRoot(kind);

  if (!existsSync(dir)) return entries;

  let children: string[];
  try {
    children = readdirSync(dir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
  } catch (err) {
    throw new DefinitionListError(dir, err);
  }
  for (const name of children.sort()) {
    const defPath = resolve(dir, name, fileName);
    if (existsSync(defPath)) {
      entries.push({ name, path: defPath, root: "config" });
    }
  }

  return entries;
}

export function listAgents(): DefinitionEntry[] {
  return discoverDefinitions("agent");
}

export function listAssignments(): DefinitionEntry[] {
  return discoverDefinitions("assignment");
}
