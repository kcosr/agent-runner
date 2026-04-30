import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, dirname, extname, relative, resolve } from "node:path";
import matter from "gray-matter";
import {
  type AgentLauncherReference,
  DIRECT_LAUNCHER_NAME,
  LAUNCHER_FILE_EXTENSIONS,
  type LoadedLauncherDefinition,
} from "../core/config/launchers.js";
import { AD_HOC_AGENT_NAME } from "../core/config/loaded.js";
import type { LoadedAgent, LoadedAssignment, LoadedTaskDefinition } from "../core/config/loaded.js";
import {
  type AuthoredAssignmentConfig,
  type LauncherDefinitionConfig,
  type TaskDef,
  agentConfigSchema,
  assignmentConfigSchema,
  authoredAssignmentConfigSchema,
  launcherDefinitionSchema,
  taskDefinitionConfigSchema,
} from "../core/config/schema.js";
import {
  definitionLayout,
  resolveDefinitionRoot,
  resolveLaunchersRoot,
  resolveStringRef,
  resolveTasksRoot,
} from "./runtime-paths.js";

type PathSegment = string | number;
type AuthoredDefinitionKind = "agent" | "assignment" | "task";
type NamedDefinitionKind = "agent" | "assignment";
type CanonicalDefinitionKind = AuthoredDefinitionKind | "launcher";
export type DefinitionKind = NamedDefinitionKind | "launcher" | "task";
type ExactScalarKind = "string" | "number" | "boolean";
type InterpolationSurface =
  | { mode: "exact"; scalarKind: ExactScalarKind; allowLiteral: boolean }
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
    public readonly kind: AuthoredDefinitionKind,
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

export class TaskConfigError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly issues: string,
  ) {
    super(`Invalid task config at ${sourcePath}:\n${issues}`);
    this.name = "TaskConfigError";
  }
}

export class TaskNotFoundError extends Error {
  constructor(
    public readonly arg: string,
    public readonly searched: string[],
  ) {
    super(`Task not found: ${arg}\n  searched:\n${searched.map((s) => `    - ${s}`).join("\n")}`);
    this.name = "TaskNotFoundError";
  }
}

export class LauncherNotFoundError extends Error {
  constructor(
    public readonly arg: string,
    public readonly searched: string[],
  ) {
    super(
      `Launcher not found: ${arg}\n  searched:\n${searched.map((s) => `    - ${s}`).join("\n")}`,
    );
    this.name = "LauncherNotFoundError";
  }
}

export class LauncherConfigError extends Error {
  constructor(
    public readonly sourcePath: string,
    public readonly issues: string,
  ) {
    super(`Invalid launcher config at ${sourcePath}:\n${issues}`);
    this.name = "LauncherConfigError";
  }
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function formatConfigPath(kind: AuthoredDefinitionKind, path: PathSegment[]): string {
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
        return { mode: "exact", scalarKind: "number", allowLiteral: false };
      case "name":
      case "backend":
      case "model":
      case "effort":
      case "launcher":
        return { mode: "exact", scalarKind: "string", allowLiteral: false };
      case "timeoutSec":
        return { mode: "exact", scalarKind: "number", allowLiteral: false };
      case "unrestricted":
        return { mode: "exact", scalarKind: "boolean", allowLiteral: false };
      default:
        return { mode: "disabled" };
    }
  }

  if (path.length === 2 && path[0] === "lockedFields" && typeof path[1] === "number") {
    return { mode: "exact", scalarKind: "string", allowLiteral: false };
  }

  if (path.length === 2 && path[0] === "launcher" && typeof path[1] === "string") {
    switch (path[1]) {
      case "command":
        return { mode: "exact", scalarKind: "string", allowLiteral: false };
      default:
        return { mode: "disabled" };
    }
  }

  if (
    path.length === 3 &&
    path[0] === "launcher" &&
    path[1] === "args" &&
    typeof path[2] === "number"
  ) {
    return { mode: "exact", scalarKind: "string", allowLiteral: false };
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
      case "path":
        return { mode: "exact", scalarKind: "string", allowLiteral: false };
      default:
        return { mode: "disabled" };
    }
  }

  if (
    path.length === 4 &&
    path[0] === "backendArgs" &&
    typeof path[1] === "string" &&
    path[2] === "extraArgs" &&
    typeof path[3] === "number"
  ) {
    return { mode: "exact", scalarKind: "string", allowLiteral: false };
  }

  return { mode: "disabled" };
}

function classifyAssignmentSurface(path: PathSegment[]): InterpolationSurface {
  if (path.length === 1) {
    switch (path[0]) {
      case "schemaVersion":
        return { mode: "exact", scalarKind: "number", allowLiteral: false };
      case "name":
      case "cwd":
        return { mode: "exact", scalarKind: "string", allowLiteral: false };
      case "message":
      case "callerInstructions":
        return { mode: "exact", scalarKind: "string", allowLiteral: true };
      case "maxRetries":
        return { mode: "exact", scalarKind: "number", allowLiteral: false };
      default:
        return { mode: "disabled" };
    }
  }

  if (path.length === 2 && path[0] === "lockedFields" && typeof path[1] === "number") {
    return { mode: "exact", scalarKind: "string", allowLiteral: false };
  }

  if (path.length === 2 && path[0] === "schedule" && typeof path[1] === "string") {
    switch (path[1]) {
      case "at":
      case "delay":
      case "cron":
      case "timezone":
      case "mode":
        return { mode: "exact", scalarKind: "string", allowLiteral: false };
      case "continueOnFailure":
        return { mode: "exact", scalarKind: "boolean", allowLiteral: false };
      default:
        return { mode: "disabled" };
    }
  }

  if (path.length === 2 && path[0] === "tasks" && typeof path[1] === "number") {
    return { mode: "exact", scalarKind: "string", allowLiteral: false };
  }

  if (path.length === 3 && path[0] === "tasks" && typeof path[1] === "number") {
    switch (path[2]) {
      case "id":
        return { mode: "exact", scalarKind: "string", allowLiteral: false };
      case "title":
      case "body":
        return { mode: "exact", scalarKind: "string", allowLiteral: true };
      default:
        return { mode: "disabled" };
    }
  }

  if (
    path.length >= 4 &&
    path[0] === "tasks" &&
    typeof path[1] === "number" &&
    path[2] === "hooks"
  ) {
    if (path.length === 5 && typeof path[3] === "number" && typeof path[4] === "string") {
      switch (path[4]) {
        case "builtin":
        case "name":
        case "path":
          return { mode: "exact", scalarKind: "string", allowLiteral: false };
        default:
          return { mode: "disabled" };
      }
    }

    if (
      path.length >= 6 &&
      typeof path[3] === "number" &&
      (path[4] === "with" || path[4] === "when")
    ) {
      return { mode: "exact", scalarKind: "string", allowLiteral: true };
    }
  }

  if (path.length >= 3 && path[0] === "vars" && typeof path[1] === "string") {
    if (path.length === 3 && typeof path[2] === "string") {
      switch (path[2]) {
        case "type":
        case "envName":
        case "default":
        case "requiredAt":
          return { mode: "exact", scalarKind: "string", allowLiteral: false };
        case "required":
          return { mode: "exact", scalarKind: "boolean", allowLiteral: false };
        case "description":
          return { mode: "exact", scalarKind: "string", allowLiteral: true };
        default:
          return { mode: "disabled" };
      }
    }

    if (path.length === 4 && path[2] === "sources" && typeof path[3] === "number") {
      return { mode: "exact", scalarKind: "string", allowLiteral: false };
    }

    if (path.length === 4 && path[2] === "values" && typeof path[3] === "number") {
      return { mode: "exact", scalarKind: "string", allowLiteral: false };
    }
  }

  if (path.length >= 3 && path[0] === "hooks" && typeof path[1] === "string") {
    if (path.length === 4 && typeof path[2] === "number" && typeof path[3] === "string") {
      switch (path[3]) {
        case "builtin":
        case "name":
        case "path":
          return { mode: "exact", scalarKind: "string", allowLiteral: false };
        default:
          return { mode: "disabled" };
      }
    }

    if (
      path.length >= 5 &&
      typeof path[2] === "number" &&
      (path[3] === "with" || path[3] === "when")
    ) {
      return { mode: "exact", scalarKind: "string", allowLiteral: true };
    }
  }

  return { mode: "disabled" };
}

function classifyTaskSurface(path: PathSegment[]): InterpolationSurface {
  if (path.length === 1) {
    switch (path[0]) {
      case "schemaVersion":
        return { mode: "exact", scalarKind: "number", allowLiteral: false };
      case "id":
        return { mode: "exact", scalarKind: "string", allowLiteral: false };
      case "title":
        return { mode: "exact", scalarKind: "string", allowLiteral: true };
      default:
        return { mode: "disabled" };
    }
  }

  if (path.length >= 2 && path[0] === "hooks") {
    if (path.length === 3 && typeof path[1] === "number" && typeof path[2] === "string") {
      switch (path[2]) {
        case "builtin":
        case "name":
        case "path":
          return { mode: "exact", scalarKind: "string", allowLiteral: false };
        default:
          return { mode: "disabled" };
      }
    }

    if (
      path.length >= 4 &&
      typeof path[1] === "number" &&
      (path[2] === "with" || path[2] === "when")
    ) {
      return { mode: "exact", scalarKind: "string", allowLiteral: true };
    }
  }

  return { mode: "disabled" };
}

function classifySurface(kind: AuthoredDefinitionKind, path: PathSegment[]): InterpolationSurface {
  if (path.length === 1 && path[0] === "instructions") {
    return { mode: "exact", scalarKind: "string", allowLiteral: true };
  }
  if (kind === "agent") {
    return classifyAgentSurface(path);
  }
  if (kind === "assignment") {
    return classifyAssignmentSurface(path);
  }
  return classifyTaskSurface(path);
}

function createInterpolationError(
  kind: AuthoredDefinitionKind,
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
  kind: AuthoredDefinitionKind,
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
  kind: AuthoredDefinitionKind,
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
  kind: AuthoredDefinitionKind,
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
  kind: AuthoredDefinitionKind,
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

function tryParseWholeEnvExpression(
  input: string,
  kind: AuthoredDefinitionKind,
  path: PathSegment[],
): EnvExpression | null {
  if (!input.startsWith("${") || !input.endsWith("}")) {
    return null;
  }

  const parts = parseInterpolatedString(input, kind, path);
  if (parts.length !== 1 || parts[0]?.type !== "expression") {
    return null;
  }
  return parts[0].expression;
}

function interpolateStringValue(
  input: string,
  kind: AuthoredDefinitionKind,
  path: PathSegment[],
): unknown {
  const surface = classifySurface(kind, path);
  if (surface.mode === "exact" && surface.allowLiteral) {
    const wholeExpression = tryParseWholeEnvExpression(input, kind, path);
    if (wholeExpression === null) {
      return input;
    }
    const resolved = resolveEnvExpressionValue(wholeExpression, kind, path);
    return coerceExactScalar(resolved, surface.scalarKind, kind, path, wholeExpression.envName);
  }

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

  return input;
}

function interpolateConfigTree(
  value: unknown,
  kind: AuthoredDefinitionKind,
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

function interpolateDefinitionInstructions(
  instructions: string,
  kind: AuthoredDefinitionKind,
): string {
  const trimmed = instructions.trim();
  if (trimmed.length === 0) {
    return "";
  }

  const resolved = interpolateStringValue(trimmed, kind, ["instructions"]);
  return typeof resolved === "string" ? resolved.trim() : String(resolved).trim();
}

function formatConfigIssues(issues: { path: PathSegment[]; message: string }[]): string {
  return issues
    .map((issue) => `  - ${issue.path.join(".") || "(root)"}: ${issue.message}`)
    .join("\n");
}

function toAgentOrAssignmentError(
  kind: NamedDefinitionKind,
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

function toTaskError(sourcePath: string, error: unknown): TaskConfigError {
  if (error instanceof DefinitionInterpolationError) {
    return new TaskConfigError(sourcePath, `  - ${error.message}`);
  }
  return new TaskConfigError(
    sourcePath,
    error instanceof Error ? `  - ${error.message}` : `  - ${String(error)}`,
  );
}

function loadDefinitionConfig<TConfig>(
  kind: AuthoredDefinitionKind,
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
    if (kind === "task") {
      throw toTaskError(sourcePath, error);
    }
    throw toAgentOrAssignmentError(kind, sourcePath, error);
  }

  const result = schema.safeParse(configData);
  if (!result.success) {
    const issues = formatConfigIssues(result.error.issues);
    if (kind === "agent") {
      throw new AgentConfigError(sourcePath, issues);
    }
    if (kind === "assignment") {
      throw new AssignmentConfigError(sourcePath, issues);
    }
    throw new TaskConfigError(sourcePath, issues);
  }

  return {
    config: result.data,
    instructions,
  };
}

function normalizePathKey(pathValue: string): string {
  return pathValue.replaceAll("\\", "/");
}

function relativePathWithinRoot(sourcePath: string, root: string): string | null {
  const rel = relative(root, sourcePath);
  if (rel.length === 0) {
    return "";
  }
  if (rel.startsWith("..") || rel === ".") {
    return null;
  }
  return normalizePathKey(rel);
}

function canonicalDefinitionIdFromPath(kind: CanonicalDefinitionKind, sourcePath: string): string {
  if (kind === "agent" || kind === "assignment") {
    const root = resolveDefinitionRoot(kind);
    const fromRoot = relativePathWithinRoot(dirname(sourcePath), root);
    return fromRoot ?? basename(dirname(sourcePath));
  }

  const root = kind === "task" ? resolveTasksRoot() : resolveLaunchersRoot();
  const fromRoot = relativePathWithinRoot(sourcePath, root);
  const relativeFilePath = fromRoot ?? basename(sourcePath);
  return normalizePathKey(
    relativeFilePath.slice(
      0,
      Math.max(0, relativeFilePath.length - extname(relativeFilePath).length),
    ),
  );
}

function isWithinCanonicalDefinitionRoot(
  kind: CanonicalDefinitionKind,
  sourcePath: string,
): boolean {
  if (kind === "agent" || kind === "assignment") {
    return relativePathWithinRoot(dirname(sourcePath), resolveDefinitionRoot(kind)) !== null;
  }
  const root = kind === "task" ? resolveTasksRoot() : resolveLaunchersRoot();
  return relativePathWithinRoot(sourcePath, root) !== null;
}

function formatIdentityMismatch(
  fieldName: string,
  authoredValue: string,
  canonicalValue: string,
  strictIdentity: boolean,
): string {
  return `  - ${fieldName}: "${authoredValue}" must match canonical id "${canonicalValue}"${strictIdentity ? "" : " (definition skipped)"}`;
}

function formatTaskReferenceIssue(ref: string, index: number, issue: string): string {
  return `  - tasks[${index}]: ${issue} (${ref})`;
}

function isLauncherFileName(name: string): boolean {
  return LAUNCHER_FILE_EXTENSIONS.includes(
    extname(name) as (typeof LAUNCHER_FILE_EXTENSIONS)[number],
  );
}

function launcherCanonicalNameFromPath(sourcePath: string): string {
  return canonicalDefinitionIdFromPath("launcher", sourcePath);
}

function toLauncherIssues(issues: { path: PathSegment[]; message: string }[]): string {
  return formatConfigIssues(issues);
}

function loadLauncherYaml(sourcePath: string): unknown {
  const ext = extname(sourcePath);
  if (!LAUNCHER_FILE_EXTENSIONS.includes(ext as (typeof LAUNCHER_FILE_EXTENSIONS)[number])) {
    throw new LauncherConfigError(
      sourcePath,
      `  - extension "${ext || "(none)"}" is not supported; use .yaml or .yml`,
    );
  }

  try {
    const raw = readFileSync(sourcePath, "utf8");
    return matter(`---\n${raw}\n---\n`).data;
  } catch (error) {
    throw new LauncherConfigError(
      sourcePath,
      error instanceof Error ? `  - ${error.message}` : `  - ${String(error)}`,
    );
  }
}

function loadLauncherDefinitionFromPath(
  sourcePath: string,
  options: { strictIdentity: boolean },
): LoadedLauncherDefinition {
  const configData = loadLauncherYaml(sourcePath);
  const parsed = launcherDefinitionSchema.safeParse(configData);
  if (!parsed.success) {
    throw new LauncherConfigError(sourcePath, toLauncherIssues(parsed.error.issues));
  }

  const config = parsed.data;
  const canonicalName = launcherCanonicalNameFromPath(sourcePath);
  if (canonicalName === DIRECT_LAUNCHER_NAME) {
    throw new LauncherConfigError(
      sourcePath,
      `  - filename stem "${DIRECT_LAUNCHER_NAME}" is reserved for the built-in direct launcher`,
    );
  }
  if (config.name === DIRECT_LAUNCHER_NAME) {
    throw new LauncherConfigError(
      sourcePath,
      `  - name: "${DIRECT_LAUNCHER_NAME}" is reserved for the built-in direct launcher`,
    );
  }
  const withinRoot = isWithinCanonicalDefinitionRoot("launcher", sourcePath);
  if (config.name !== undefined && config.name !== canonicalName && withinRoot) {
    throw new LauncherConfigError(
      sourcePath,
      formatIdentityMismatch("name", config.name, canonicalName, options.strictIdentity),
    );
  }
  const resolvedName = !withinRoot && config.name !== undefined ? config.name : canonicalName;

  return {
    kind: "prefix",
    name: resolvedName,
    command: config.command,
    args: [...config.args],
    sourcePath,
    root: "config",
    config: {
      schemaVersion: 1,
      name: config.name,
      command: config.command,
      args: [...config.args],
    },
  };
}

function normalizeAgentLauncherReference(
  launcher: LoadedAgent["config"]["launcher"],
  sourcePath: string,
): AgentLauncherReference | undefined {
  if (launcher === undefined) {
    return undefined;
  }
  if (typeof launcher === "string") {
    const resolved = resolveStringRef(launcher, dirname(sourcePath));
    if (resolved.kind === "path") {
      return {
        kind: "path",
        ref: resolved.ref,
        path: resolved.path,
      };
    }
    return {
      kind: "name",
      ref: resolved.ref,
      name: resolved.name,
    };
  }
  return {
    kind: "inline",
    config: {
      command: launcher.command,
      args: [...(launcher.args ?? [])],
    },
  };
}

function resolveDefinitionPath(
  kind: NamedDefinitionKind,
  arg: string,
  cwd: string,
): { path: string; searched: string[] } {
  const { fileName } = definitionLayout(kind);

  const resolved = resolveStringRef(arg, cwd);
  if (resolved.kind === "path") {
    return { path: resolved.path, searched: [resolved.path] };
  }

  const candidate = resolve(resolveDefinitionRoot(kind), resolved.name, fileName);
  return {
    path: existsSync(candidate) ? candidate : "",
    searched: [candidate],
  };
}

function resolveNamedFilePath(
  root: string,
  name: string,
  extensions: readonly string[],
): { path: string; searched: string[] } {
  const searched = extensions.map((extension) => resolve(root, `${name}${extension}`));
  const path = searched.find((candidate) => existsSync(candidate)) ?? "";
  return { path, searched };
}

function resolveNamedTaskPath(name: string): { path: string; searched: string[] } {
  return resolveNamedFilePath(resolveTasksRoot(), name, [".md"]);
}

function resolveTaskPath(ref: string, assignmentSourcePath: string): string {
  const resolved = resolveStringRef(ref, dirname(assignmentSourcePath));
  if (resolved.kind === "path") {
    if (!existsSync(resolved.path)) {
      throw new AssignmentConfigError(
        assignmentSourcePath,
        `  - task reference "${ref}" not found at ${resolved.path}`,
      );
    }
    return resolved.path;
  }

  const { path, searched } = resolveNamedTaskPath(resolved.name);
  if (!path) {
    throw new AssignmentConfigError(
      assignmentSourcePath,
      `  - task reference "${ref}" not found\n    searched:\n${searched.map((candidate) => `      - ${candidate}`).join("\n")}`,
    );
  }
  return path;
}

function resolveTaskDefinitionPath(arg: string, cwd: string): { path: string; searched: string[] } {
  const resolved = resolveStringRef(arg, cwd);
  if (resolved.kind === "path") {
    return { path: resolved.path, searched: [resolved.path] };
  }
  return resolveNamedTaskPath(resolved.name);
}

function loadTaskDefinitionFromPath(
  sourcePath: string,
  options: { strictIdentity: boolean },
): TaskDef {
  const raw = readFileSync(sourcePath, "utf8");
  const loaded = loadDefinitionConfig("task", sourcePath, raw, taskDefinitionConfigSchema);

  const canonicalId = canonicalDefinitionIdFromPath("task", sourcePath);
  const withinRoot = isWithinCanonicalDefinitionRoot("task", sourcePath);
  if (loaded.config.id !== undefined && loaded.config.id !== canonicalId && withinRoot) {
    throw new TaskConfigError(
      sourcePath,
      formatIdentityMismatch("id", loaded.config.id, canonicalId, options.strictIdentity),
    );
  }
  const resolvedId = !withinRoot && loaded.config.id !== undefined ? loaded.config.id : canonicalId;

  return {
    id: resolvedId,
    title: loaded.config.title,
    body: loaded.instructions,
    hooks: loaded.config.hooks,
  };
}

function resolveAssignmentTasks(
  config: AuthoredAssignmentConfig,
  sourcePath: string,
  options: { strictIdentity: boolean },
): TaskDef[] {
  const resolvedTasks: TaskDef[] = [];

  for (const [index, entry] of config.tasks.entries()) {
    if (typeof entry !== "string") {
      resolvedTasks.push(entry);
      continue;
    }

    const taskPath = resolveTaskPath(entry, sourcePath);
    try {
      resolvedTasks.push(loadTaskDefinitionFromPath(taskPath, options));
    } catch (error) {
      if (error instanceof TaskConfigError) {
        throw new AssignmentConfigError(
          sourcePath,
          formatTaskReferenceIssue(entry, index, error.message),
        );
      }
      throw error;
    }
  }

  return resolvedTasks;
}

function loadAgentDefinitionFromPath(
  sourcePath: string,
  options: { strictIdentity: boolean },
): LoadedAgent {
  const raw = readFileSync(sourcePath, "utf8");
  const loaded = loadDefinitionConfig("agent", sourcePath, raw, agentConfigSchema);
  const canonicalName = canonicalDefinitionIdFromPath("agent", sourcePath);
  if (
    loaded.config.name !== canonicalName &&
    isWithinCanonicalDefinitionRoot("agent", sourcePath)
  ) {
    throw new AgentConfigError(
      sourcePath,
      formatIdentityMismatch("name", loaded.config.name, canonicalName, options.strictIdentity),
    );
  }
  if (loaded.config.name === AD_HOC_AGENT_NAME) {
    throw new AgentConfigError(
      sourcePath,
      `  - name: "${AD_HOC_AGENT_NAME}" is reserved for CLI-synthesized ad-hoc agents. Please rename.`,
    );
  }

  return {
    config: loaded.config,
    instructions: loaded.instructions,
    launcher: normalizeAgentLauncherReference(loaded.config.launcher, sourcePath),
    sourcePath,
  };
}

function loadAssignmentDefinitionFromPath(
  sourcePath: string,
  options: { strictIdentity: boolean },
): LoadedAssignment {
  const raw = readFileSync(sourcePath, "utf8");
  const authored = loadDefinitionConfig(
    "assignment",
    sourcePath,
    raw,
    authoredAssignmentConfigSchema,
  );
  const canonicalName = canonicalDefinitionIdFromPath("assignment", sourcePath);
  if (
    authored.config.name !== canonicalName &&
    isWithinCanonicalDefinitionRoot("assignment", sourcePath)
  ) {
    throw new AssignmentConfigError(
      sourcePath,
      formatIdentityMismatch("name", authored.config.name, canonicalName, options.strictIdentity),
    );
  }

  const resolvedConfig = assignmentConfigSchema.safeParse({
    ...authored.config,
    tasks: resolveAssignmentTasks(authored.config, sourcePath, options),
  });
  if (!resolvedConfig.success) {
    throw new AssignmentConfigError(sourcePath, formatConfigIssues(resolvedConfig.error.issues));
  }

  return {
    config: resolvedConfig.data,
    instructions: authored.instructions,
    sourcePath,
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
  return loadAgentDefinitionFromPath(sourcePath, { strictIdentity: true });
}

export function loadAssignmentConfig(arg: string, cwd: string = process.cwd()): LoadedAssignment {
  const sourcePath = resolveAssignmentPath(arg, cwd);
  return loadAssignmentDefinitionFromPath(sourcePath, { strictIdentity: true });
}

export function loadTaskConfig(arg: string, cwd: string = process.cwd()): LoadedTaskDefinition {
  const { path, searched } = resolveTaskDefinitionPath(arg, cwd);
  if (!path || !existsSync(path)) {
    throw new TaskNotFoundError(arg, searched);
  }
  return {
    task: loadTaskDefinitionFromPath(path, { strictIdentity: true }),
    sourcePath: path,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Definition catalog — enumerate available definitions from the
// TASK_RUNNER_CONFIG_DIR / XDG config root. Used by `list` and `show`.
// ─────────────────────────────────────────────────────────────────────────────

export interface DefinitionEntry {
  name: string;
  path: string | null;
  root: "config" | "builtin";
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

export interface DefinitionListWarnings {
  entries: DefinitionEntry[];
  warnings: string[];
}

function discoverDefinitionSourcePaths(root: string, matcher: (name: string) => boolean): string[] {
  if (!existsSync(root)) {
    return [];
  }

  const sourcePaths: string[] = [];
  const pending = [root];

  while (pending.length > 0) {
    const dir = pending.pop();
    if (!dir) {
      continue;
    }

    try {
      const children = readdirSync(dir, { withFileTypes: true });
      for (const child of children) {
        const childPath = resolve(dir, child.name);
        if (child.isDirectory()) {
          pending.push(childPath);
          continue;
        }
        if (child.isFile() && matcher(child.name)) {
          sourcePaths.push(childPath);
        }
      }
    } catch (error) {
      throw new DefinitionListError(dir, error);
    }
  }

  return sourcePaths.sort((left, right) =>
    normalizePathKey(left).localeCompare(normalizePathKey(right)),
  );
}

function listNamedDefinitions(kind: NamedDefinitionKind): DefinitionListWarnings {
  const root = resolveDefinitionRoot(kind);
  const { fileName } = definitionLayout(kind);
  const entries: DefinitionEntry[] = [];
  const warnings: string[] = [];
  const sourcePaths = discoverDefinitionSourcePaths(root, (name) => name === fileName);

  for (const sourcePath of sourcePaths) {
    try {
      const loaded =
        kind === "agent"
          ? loadAgentDefinitionFromPath(sourcePath, { strictIdentity: false })
          : loadAssignmentDefinitionFromPath(sourcePath, { strictIdentity: false });
      entries.push({
        name: loaded.config.name,
        path: loaded.sourcePath,
        root: "config",
      });
    } catch (error) {
      if (error instanceof AgentConfigError || error instanceof AssignmentConfigError) {
        warnings.push(error.message);
        continue;
      }
      throw error;
    }
  }

  return { entries, warnings };
}

export function listAgentDefinitions(): DefinitionListWarnings {
  return listNamedDefinitions("agent");
}

export function listAssignmentDefinitions(): DefinitionListWarnings {
  return listNamedDefinitions("assignment");
}

export function listTaskDefinitions(): DefinitionListWarnings {
  const entries: DefinitionEntry[] = [];
  const warnings: string[] = [];
  const sourcePaths = discoverDefinitionSourcePaths(
    resolveTasksRoot(),
    (name) => extname(name) === ".md",
  );

  for (const sourcePath of sourcePaths) {
    try {
      const task = loadTaskDefinitionFromPath(sourcePath, { strictIdentity: false });
      entries.push({
        name: task.id,
        path: sourcePath,
        root: "config",
      });
    } catch (error) {
      if (error instanceof TaskConfigError) {
        warnings.push(error.message);
        continue;
      }
      throw error;
    }
  }

  return { entries, warnings };
}

export function listAgents(): DefinitionEntry[] {
  return listAgentDefinitions().entries;
}

export function listAssignments(): DefinitionEntry[] {
  return listAssignmentDefinitions().entries;
}

function resolveNamedLauncherPath(name: string): { path: string; searched: string[] } {
  return resolveNamedFilePath(resolveLaunchersRoot(), name, LAUNCHER_FILE_EXTENSIONS);
}

export function resolveLauncherPath(arg: string, cwd: string = process.cwd()): string {
  if (arg === DIRECT_LAUNCHER_NAME) {
    return DIRECT_LAUNCHER_NAME;
  }
  const resolved = resolveStringRef(arg, cwd);
  if (resolved.kind === "path") {
    if (!existsSync(resolved.path)) {
      throw new LauncherNotFoundError(arg, [resolved.path]);
    }
    return resolved.path;
  }
  const { path, searched } = resolveNamedLauncherPath(resolved.name);
  if (!path) {
    throw new LauncherNotFoundError(arg, searched);
  }
  return path;
}

export function loadLauncherConfig(
  arg: string,
  cwd: string = process.cwd(),
): LoadedLauncherDefinition {
  if (arg === DIRECT_LAUNCHER_NAME) {
    return {
      kind: "direct",
      name: DIRECT_LAUNCHER_NAME,
      sourcePath: null,
      root: "builtin",
    };
  }
  const resolved = resolveStringRef(arg, cwd);
  if (resolved.kind === "path") {
    const sourcePath = resolveLauncherPath(arg, cwd);
    return loadLauncherDefinitionFromPath(sourcePath, { strictIdentity: true });
  }
  const discovered = listLaunchers();
  const entry = discovered.entries.find((candidate) => candidate.name === resolved.name);
  if (!entry) {
    const { searched } = resolveNamedLauncherPath(resolved.name);
    throw new LauncherNotFoundError(arg, searched);
  }
  if (entry.root === "builtin") {
    return {
      kind: "direct",
      name: DIRECT_LAUNCHER_NAME,
      sourcePath: null,
      root: "builtin",
    };
  }
  if (entry.path === null) {
    throw new LauncherNotFoundError(arg, []);
  }
  return loadLauncherDefinitionFromPath(entry.path, { strictIdentity: true });
}

export function listLaunchers(): DefinitionListWarnings {
  const entries: DefinitionEntry[] = [{ name: DIRECT_LAUNCHER_NAME, path: null, root: "builtin" }];
  const warnings: string[] = [];
  const sourcePaths = discoverDefinitionSourcePaths(resolveLaunchersRoot(), isLauncherFileName);

  for (const sourcePath of sourcePaths) {
    try {
      const loaded = loadLauncherDefinitionFromPath(sourcePath, { strictIdentity: false });
      entries.push({ name: loaded.name, path: loaded.sourcePath, root: "config" });
    } catch (error) {
      if (error instanceof LauncherConfigError) {
        warnings.push(error.message);
        continue;
      }
      throw error;
    }
  }

  return { entries, warnings };
}
