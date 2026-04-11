import { existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, resolve } from "node:path";
import matter from "gray-matter";
import type { RunManifest } from "../runner/manifest.js";
import {
  type AgentConfig,
  type AssignmentConfig,
  type LockableField,
  agentConfigSchema,
  assignmentConfigSchema,
} from "./schema.js";

// Reserved agent name for CLI-synthesized ad-hoc runs. `loadAgentConfig`
// refuses to load any on-disk agent file that uses this name so it
// can't collide with a synthesized one.
export const AD_HOC_AGENT_NAME = "ad-hoc";

export interface LoadedAgent {
  config: AgentConfig;
  instructions: string;
  // null for ad-hoc agents synthesized from CLI overrides and for
  // agents reconstructed from a resumed manifest (since resume never
  // re-reads the source file under the manifest-canonical design).
  sourcePath: string | null;
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

function definitionLayout(kind: "agent" | "assignment"): { dirName: string; fileName: string } {
  return kind === "agent"
    ? { dirName: "agents", fileName: "agent.md" }
    : { dirName: "assignments", fileName: "assignment.md" };
}

function resolveDefinitionPath(
  kind: "agent" | "assignment",
  arg: string,
  cwd: string,
): { path: string; searched: string[] } {
  const { dirName, fileName } = definitionLayout(kind);

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

// Reconstruct a LoadedAgent from a resumed run's manifest. Post the
// manifest-canonical refactor this is the only path that produces a
// LoadedAgent on resume — we never re-read the agent's source file.
// All fields come from frozen manifest state.
export function loadedAgentFromManifest(manifest: RunManifest): LoadedAgent {
  const effort = manifest.effort === null ? undefined : (manifest.effort as AgentConfig["effort"]);
  const config: AgentConfig = {
    schemaVersion: 1,
    name: manifest.agent.name,
    backend: manifest.backend as AgentConfig["backend"],
    model: manifest.model ?? undefined,
    effort,
    timeoutSec: manifest.timeoutSec,
    unrestricted: manifest.unrestricted,
    cwd: manifest.cwd,
    lockedFields: manifest.lockedFields,
  };
  return {
    config,
    instructions: manifest.agent.instructions,
    sourcePath: manifest.agent.sourcePath,
  };
}

// Synthesize a LoadedAgent from CLI overrides when --agent was
// omitted. Name is always `ad-hoc`, role instructions are empty
// (there's no --instructions flag), lockedFields is empty (ad-hoc
// agents aren't lockable since there's no source to lock against).
export interface AdHocAgentInputs {
  backend: AgentConfig["backend"];
  model?: string;
  effort?: AgentConfig["effort"];
  timeoutSec?: number;
  unrestricted?: boolean;
  cwd?: string;
}

export function synthesizeAdHocAgent(inputs: AdHocAgentInputs): LoadedAgent {
  const config: AgentConfig = {
    schemaVersion: 1,
    name: AD_HOC_AGENT_NAME,
    backend: inputs.backend,
    model: inputs.model,
    effort: inputs.effort,
    timeoutSec: inputs.timeoutSec ?? 3600,
    unrestricted: inputs.unrestricted ?? false,
    cwd: inputs.cwd ?? ".",
    lockedFields: [] as LockableField[],
  };
  return {
    config,
    instructions: "",
    sourcePath: null,
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
// Definition catalog — enumerate available definitions from local and
// $TASK_RUNNER_HOME roots. Used by the `list` and `show` commands.
// ─────────────────────────────────────────────────────────────────────────────

export type DefinitionKind = "agent" | "assignment";

export interface DefinitionEntry {
  name: string;
  path: string;
  root: "local" | "global";
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

function discoverDefinitions(kind: DefinitionKind, cwd: string = process.cwd()): DefinitionEntry[] {
  const { dirName, fileName } = definitionLayout(kind);
  const seen = new Set<string>();
  const entries: DefinitionEntry[] = [];

  const roots: Array<{ dir: string; root: "local" | "global" }> = [
    { dir: resolve(cwd, dirName), root: "local" },
    { dir: resolve(taskRunnerHome(), dirName), root: "global" },
  ];

  for (const { dir, root } of roots) {
    if (!existsSync(dir)) continue;
    let children: string[];
    try {
      children = readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch (err) {
      throw new DefinitionListError(dir, err);
    }
    for (const name of children.sort()) {
      if (seen.has(name)) continue;
      const defPath = resolve(dir, name, fileName);
      if (existsSync(defPath)) {
        seen.add(name);
        entries.push({ name, path: defPath, root });
      }
    }
  }

  return entries;
}

export function listAgents(cwd?: string): DefinitionEntry[] {
  return discoverDefinitions("agent", cwd);
}

export function listAssignments(cwd?: string): DefinitionEntry[] {
  return discoverDefinitions("assignment", cwd);
}
