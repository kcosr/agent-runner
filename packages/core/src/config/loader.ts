import { existsSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import matter from "gray-matter";
import { AD_HOC_AGENT_NAME } from "../core/config/loaded.js";
import type { LoadedAgent, LoadedAssignment } from "../core/config/loaded.js";
import { agentConfigSchema, assignmentConfigSchema } from "../core/config/schema.js";
import {
  definitionLayout,
  isPathArg,
  resolveDefinitionRoot,
  resolveInputPath,
} from "./runtime-paths.js";

type PathSegment = string | number;
export type DefinitionKind = "agent" | "assignment";
type ExactScalarKind = "string" | "number" | "boolean";
type InterpolationSurface =
  | { mode: "exact"; scalarKind: ExactScalarKind }
  | { mode: "prose" }
  | { mode: "disabled" };
type InterpolationReason = "missing" | "empty" | "invalid syntax" | "mismatch with field surface";

interface EnvExpression {
  envName: string;
  fallbackKind: "none" | "unset_or_empty" | "unset_only";
  fallbackValue: string | null;
}

type ParsedStringPart =
  | { type: "text"; value: string }
  | { type: "expression"; expression: EnvExpression };

class DefinitionInterpolationError extends Error {
  constructor(
    public readonly kind: DefinitionKind,
    public readonly configPath: string,
    public readonly envName: string,
    public readonly reason: InterpolationReason,
    detail?: string,
  ) {
    super(`${configPath}: env ${envName} ${reason}${detail ? ` (${detail})` : ""}`);
    this.name = "DefinitionInterpolationError";
  }
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

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatConfigPath(kind: DefinitionKind, path: PathSegment[]): string {
  if (path.length === 0) return kind;

  let rendered = kind;
  for (const segment of path) {
    rendered += typeof segment === "number" ? `[${segment}]` : `.${segment}`;
  }
  return rendered;
}

function classifyAgentSurface(path: PathSegment[]): InterpolationSurface {
  if (path.length === 1) {
    switch (path[0]) {
      case "schemaVersion":
        return { mode: "exact", scalarKind: "number" };
      case "name":
      case "backend":
      case "model":
      case "effort":
        return { mode: "exact", scalarKind: "string" };
      case "timeoutSec":
        return { mode: "exact", scalarKind: "number" };
      case "unrestricted":
        return { mode: "exact", scalarKind: "boolean" };
      default:
        return { mode: "disabled" };
    }
  }

  if (path.length === 2 && path[0] === "lockedFields" && typeof path[1] === "number") {
    return { mode: "exact", scalarKind: "string" };
  }

  if (
    path.length === 4 &&
    path[0] === "backendSpecific" &&
    path[1] === "codex" &&
    path[2] === "transport" &&
    typeof path[3] === "string"
  ) {
    switch (path[3]) {
      case "type":
      case "url":
        return { mode: "exact", scalarKind: "string" };
      default:
        return { mode: "disabled" };
    }
  }

  return { mode: "disabled" };
}

function classifyAssignmentSurface(path: PathSegment[]): InterpolationSurface {
  if (path.length === 1) {
    switch (path[0]) {
      case "schemaVersion":
        return { mode: "exact", scalarKind: "number" };
      case "name":
      case "cwd":
        return { mode: "exact", scalarKind: "string" };
      case "message":
      case "callerInstructions":
        return { mode: "prose" };
      case "maxRetries":
        return { mode: "exact", scalarKind: "number" };
      default:
        return { mode: "disabled" };
    }
  }

  if (path.length === 2 && path[0] === "lockedFields" && typeof path[1] === "number") {
    return { mode: "exact", scalarKind: "string" };
  }

  if (path.length === 3 && path[0] === "tasks" && typeof path[1] === "number") {
    switch (path[2]) {
      case "id":
        return { mode: "exact", scalarKind: "string" };
      case "title":
      case "body":
        return { mode: "prose" };
      default:
        return { mode: "disabled" };
    }
  }

  if (path.length >= 3 && path[0] === "vars" && typeof path[1] === "string") {
    if (path.length === 3 && typeof path[2] === "string") {
      switch (path[2]) {
        case "type":
        case "source":
        case "envName":
        case "default":
        case "requiredAt":
          return { mode: "exact", scalarKind: "string" };
        case "required":
          return { mode: "exact", scalarKind: "boolean" };
        case "description":
          return { mode: "prose" };
        default:
          return { mode: "disabled" };
      }
    }

    if (path.length === 4 && path[2] === "values" && typeof path[3] === "number") {
      return { mode: "exact", scalarKind: "string" };
    }
  }

  if (path.length >= 3 && path[0] === "hooks" && typeof path[1] === "string") {
    if (path.length === 4 && typeof path[2] === "number" && typeof path[3] === "string") {
      switch (path[3]) {
        case "builtin":
        case "name":
        case "path":
          return { mode: "exact", scalarKind: "string" };
        default:
          return { mode: "disabled" };
      }
    }

    if (
      path.length >= 5 &&
      typeof path[2] === "number" &&
      (path[3] === "with" || path[3] === "when")
    ) {
      return { mode: "prose" };
    }
  }

  return { mode: "disabled" };
}

function classifySurface(kind: DefinitionKind, path: PathSegment[]): InterpolationSurface {
  if (path.length === 1 && path[0] === "instructions") {
    return { mode: "prose" };
  }
  return kind === "agent" ? classifyAgentSurface(path) : classifyAssignmentSurface(path);
}

function createInterpolationError(
  kind: DefinitionKind,
  path: PathSegment[],
  envName: string,
  reason: InterpolationReason,
  detail?: string,
): DefinitionInterpolationError {
  return new DefinitionInterpolationError(
    kind,
    formatConfigPath(kind, path),
    envName,
    reason,
    detail,
  );
}

function parseEnvExpression(
  kind: DefinitionKind,
  path: PathSegment[],
  token: string,
): EnvExpression {
  const inner = token.slice(2, -1);
  const match = inner.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:(:-|-)([\s\S]*))?$/);
  if (!match) {
    const envHint = inner.match(/[A-Za-z_][A-Za-z0-9_]*/) ? inner : token;
    throw createInterpolationError(kind, path, envHint, "invalid syntax", `token ${token}`);
  }

  const envName = match[1] ?? inner;
  const fallbackOperator = match[2];
  const fallbackValue = match[3] ?? "";
  return {
    envName,
    fallbackKind:
      fallbackOperator === ":-"
        ? "unset_or_empty"
        : fallbackOperator === "-"
          ? "unset_only"
          : "none",
    fallbackValue: fallbackOperator ? fallbackValue : null,
  };
}

function parseInterpolatedString(
  input: string,
  kind: DefinitionKind,
  path: PathSegment[],
): ParsedStringPart[] {
  const parts: ParsedStringPart[] = [];
  let cursor = 0;

  while (cursor < input.length) {
    const start = input.indexOf("${", cursor);
    if (start === -1) {
      if (cursor < input.length) {
        parts.push({ type: "text", value: input.slice(cursor) });
      }
      break;
    }

    if (start > cursor) {
      parts.push({ type: "text", value: input.slice(cursor, start) });
    }

    const end = input.indexOf("}", start + 2);
    if (end === -1) {
      const envHint =
        input.slice(start + 2).match(/[A-Za-z_][A-Za-z0-9_]*/)?.[0] ?? input.slice(start);
      throw createInterpolationError(
        kind,
        path,
        envHint,
        "invalid syntax",
        "missing closing brace",
      );
    }

    const token = input.slice(start, end + 1);
    parts.push({
      type: "expression",
      expression: parseEnvExpression(kind, path, token),
    });
    cursor = end + 1;
  }

  return parts;
}

function resolveEnvExpressionValue(
  expression: EnvExpression,
  kind: DefinitionKind,
  path: PathSegment[],
): string {
  const current = process.env[expression.envName];

  if (current === undefined) {
    if (expression.fallbackKind === "unset_only" || expression.fallbackKind === "unset_or_empty") {
      return expression.fallbackValue ?? "";
    }
    throw createInterpolationError(kind, path, expression.envName, "missing");
  }

  if (current.length === 0) {
    if (expression.fallbackKind === "unset_or_empty") {
      return expression.fallbackValue ?? "";
    }
    if (expression.fallbackKind === "none") {
      throw createInterpolationError(kind, path, expression.envName, "empty");
    }
  }

  return current;
}

function coerceExactScalar(
  value: string,
  scalarKind: ExactScalarKind,
  kind: DefinitionKind,
  path: PathSegment[],
  envName: string,
): string | number | boolean {
  if (scalarKind === "string") {
    return value;
  }

  if (scalarKind === "number") {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw createInterpolationError(kind, path, envName, "empty");
    }

    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed)) {
      throw createInterpolationError(
        kind,
        path,
        envName,
        "invalid syntax",
        `resolved value "${value}" is not a valid number`,
      );
    }
    return parsed;
  }

  const trimmed = value.trim().toLowerCase();
  if (trimmed === "true") return true;
  if (trimmed === "false") return false;
  throw createInterpolationError(
    kind,
    path,
    envName,
    "invalid syntax",
    `resolved value "${value}" is not a valid boolean`,
  );
}

function interpolateStringValue(input: string, kind: DefinitionKind, path: PathSegment[]): unknown {
  const surface = classifySurface(kind, path);
  const parts = parseInterpolatedString(input, kind, path);
  let expressionCount = 0;
  let firstExpression: EnvExpression | null = null;
  for (const part of parts) {
    if (part.type !== "expression") continue;
    expressionCount += 1;
    firstExpression ??= part.expression;
  }
  if (expressionCount === 0 || firstExpression === null) {
    return input;
  }

  if (surface.mode === "disabled") {
    throw createInterpolationError(
      kind,
      path,
      firstExpression.envName,
      "mismatch with field surface",
      "field does not allow env interpolation",
    );
  }

  if (surface.mode === "exact") {
    const onlyPart = parts[0];
    if (expressionCount !== 1 || parts.length !== 1 || onlyPart?.type !== "expression") {
      throw createInterpolationError(
        kind,
        path,
        firstExpression.envName,
        "mismatch with field surface",
        "exact-match-only fields must be a single ${...} expression",
      );
    }

    const resolved = resolveEnvExpressionValue(onlyPart.expression, kind, path);
    return coerceExactScalar(resolved, surface.scalarKind, kind, path, onlyPart.expression.envName);
  }

  let output = "";
  for (const part of parts) {
    if (part.type === "text") {
      output += part.value;
      continue;
    }
    output += resolveEnvExpressionValue(part.expression, kind, path);
  }
  return output;
}

function interpolateConfigTree(
  value: unknown,
  kind: DefinitionKind,
  path: PathSegment[] = [],
): unknown {
  if (typeof value === "string") {
    return interpolateStringValue(value, kind, path);
  }

  if (Array.isArray(value)) {
    let changed = false;
    const next = value.map((entry, index) => {
      const interpolated = interpolateConfigTree(entry, kind, [...path, index]);
      changed ||= interpolated !== entry;
      return interpolated;
    });
    return changed ? next : value;
  }

  if (isObjectRecord(value)) {
    let changed = false;
    const nextEntries = Object.entries(value).map(([key, entry]) => {
      const interpolated = interpolateConfigTree(entry, kind, [...path, key]);
      changed ||= interpolated !== entry;
      return [key, interpolated];
    });
    return changed ? Object.fromEntries(nextEntries) : value;
  }

  return value;
}

function interpolateDefinitionInstructions(instructions: string, kind: DefinitionKind): string {
  const resolved = interpolateStringValue(instructions, kind, ["instructions"]);
  return typeof resolved === "string" ? resolved.trim() : String(resolved).trim();
}

function formatConfigIssues(issues: { path: PathSegment[]; message: string }[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function toAgentOrAssignmentError(
  kind: DefinitionKind,
  sourcePath: string,
  error: unknown,
): AgentConfigError | AssignmentConfigError {
  if (error instanceof DefinitionInterpolationError) {
    const issues = `  - ${error.message}`;
    return kind === "agent"
      ? new AgentConfigError(sourcePath, issues)
      : new AssignmentConfigError(sourcePath, issues);
  }

  if (kind === "agent") {
    return new AgentConfigError(sourcePath, String(error));
  }
  return new AssignmentConfigError(sourcePath, String(error));
}

function loadDefinitionConfig<TConfig>(
  kind: DefinitionKind,
  sourcePath: string,
  raw: string,
  schema: {
    safeParse(
      data: unknown,
    ):
      | { success: true; data: TConfig }
      | { success: false; error: { issues: { path: PathSegment[]; message: string }[] } };
  },
): { config: TConfig; instructions: string } {
  const parsed = matter(raw);

  let configData: unknown;
  let instructions: string;
  try {
    configData = interpolateConfigTree(parsed.data, kind);
    instructions = interpolateDefinitionInstructions(parsed.content, kind);
  } catch (error) {
    throw toAgentOrAssignmentError(kind, sourcePath, error);
  }

  const result = schema.safeParse(configData);
  if (!result.success) {
    const issues = formatConfigIssues(result.error.issues);
    throw kind === "agent"
      ? new AgentConfigError(sourcePath, issues)
      : new AssignmentConfigError(sourcePath, issues);
  }

  return {
    config: result.data,
    instructions,
  };
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
  const loaded = loadDefinitionConfig("agent", sourcePath, raw, agentConfigSchema);
  // Reserved name: an on-disk agent cannot declare itself as "ad-hoc".
  // The synthesized CLI path uses this name, and letting a file claim
  // it would produce ambiguous manifests.
  if (loaded.config.name === AD_HOC_AGENT_NAME) {
    throw new AgentConfigError(
      sourcePath,
      `  - name: "${AD_HOC_AGENT_NAME}" is reserved for CLI-synthesized ad-hoc agents. Please rename.`,
    );
  }
  return {
    config: loaded.config,
    instructions: loaded.instructions,
    sourcePath,
  };
}

export function loadAssignmentConfig(arg: string, cwd: string = process.cwd()): LoadedAssignment {
  const sourcePath = resolveAssignmentPath(arg, cwd);
  const raw = readFileSync(sourcePath, "utf8");
  const loaded = loadDefinitionConfig("assignment", sourcePath, raw, assignmentConfigSchema);
  return {
    config: loaded.config,
    instructions: loaded.instructions,
    sourcePath,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Definition catalog — enumerate available definitions from the
// TASK_RUNNER_CONFIG_DIR / XDG config root. Used by `list` and `show`.
// ─────────────────────────────────────────────────────────────────────────────

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
