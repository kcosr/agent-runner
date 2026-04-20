import type { RunCommandOverrides } from "@task-runner/core/app/service.js";
import type {
  BackendSpecificConfig,
  CodexTransportConfig,
} from "@task-runner/core/core/backends/types.js";
import { BACKEND_IDS, isWsOrWssUrl } from "@task-runner/core/core/backends/types.js";
import type { RunListScopeFilter } from "@task-runner/core/core/commands/service.js";
import { isNamedLauncherOverride } from "@task-runner/core/core/config/launchers.js";
import { trimRunName } from "@task-runner/core/util/run-name.js";
import type {
  RunSetBackendSessionParams,
  RunSetNameParams,
  RunSetNoteParams,
  RunSetPinnedParams,
  RunsListParams,
  RunsStartParams,
} from "./protocol.js";

export class RequestValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RequestValidationError";
  }
}

export function asRecord(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new RequestValidationError(`${label} must be an object`);
  }
  return value as Record<string, unknown>;
}

export function optionalString(value: unknown, label: string): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string") {
    throw new RequestValidationError(`${label} must be a string`);
  }
  return value;
}

export function optionalNonEmptyString(value: unknown, label: string): string | undefined {
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    return undefined;
  }
  if (stringValue.trim().length === 0) {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
  return stringValue;
}

export function requiredString(value: unknown, label: string): string {
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  return stringValue;
}

export function requiredNonEmptyString(value: unknown, label: string): string {
  const stringValue = requiredString(value, label);
  if (stringValue.trim().length === 0) {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
  return stringValue;
}

export function requiredRunIdString(value: unknown, label: string): string {
  const stringValue = requiredString(value, label);
  if (stringValue.includes("/") || stringValue.includes("\\") || stringValue.includes("..")) {
    throw new RequestValidationError(`${label} must be a run id, not a path`);
  }
  return stringValue;
}

export function optionalHeaderString(
  value: string | string[] | undefined,
  label: string,
): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    throw new RequestValidationError(`${label} must be a single header value`);
  }
  return value;
}

export function requiredHeaderString(value: string | string[] | undefined, label: string): string {
  const stringValue = optionalHeaderString(value, label);
  if (stringValue === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  if (stringValue.trim().length === 0) {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
  return stringValue;
}

export function requiredNullableRunName(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  try {
    return trimRunName(stringValue);
  } catch {
    throw new RequestValidationError(`${label} cannot be empty`);
  }
}

export function requiredNullableString(value: unknown, label: string): string | null {
  if (value === null) {
    return null;
  }
  return requiredString(value, label);
}

export function requiredBoolean(value: unknown, label: string): boolean {
  const bool = optionalBoolean(value, label);
  if (bool === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  return bool;
}

export function stringRecord(value: unknown, label: string): Record<string, string> {
  const record = asRecord(value, label);
  const result: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry !== "string") {
      throw new RequestValidationError(`${label}.${key} must be a string`);
    }
    result[key] = entry;
  }
  return result;
}

export function optionalBoolean(value: unknown, label: string): boolean | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "boolean") {
    throw new RequestValidationError(`${label} must be a boolean`);
  }
  return value;
}

export function optionalFiniteNumber(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new RequestValidationError(`${label} must be a finite number`);
  }
  return value;
}

export function optionalPositiveInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) {
    throw new RequestValidationError(`${label} must be a positive integer`);
  }
  return value;
}

export function optionalNonNegativeInteger(value: unknown, label: string): number | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new RequestValidationError(`${label} must be a non-negative integer`);
  }
  return value;
}

export function optionalStringArray(value: unknown, label: string): string[] | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string")) {
    throw new RequestValidationError(`${label} must be an array of strings`);
  }
  return [...value];
}

export function optionalEnum<T extends string>(
  value: unknown,
  label: string,
  allowed: readonly T[],
): T | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new RequestValidationError(`${label} must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

export function parseBooleanQueryValue(value: string | null, label: string): boolean | undefined {
  if (value === null) {
    return undefined;
  }
  if (value === "true") {
    return true;
  }
  if (value === "false") {
    return false;
  }
  throw new RequestValidationError(`${label} must be "true" or "false"`);
}

function validateAbsoluteCodexWsUrl(value: string, label: string): string {
  if (!isWsOrWssUrl(value)) {
    throw new RequestValidationError(`${label} must be an absolute ws:// or wss:// URL`);
  }
  return value;
}

function optionalCodexTransport(value: unknown, label: string): CodexTransportConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, label);
  const allowedKeys = new Set(["type", "url"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }

  const type = requiredString(record.type, `${label}.type`);
  if (type === "stdio") {
    if (record.url !== undefined) {
      throw new RequestValidationError(`${label}.url is not supported for stdio transport`);
    }
    return { type: "stdio" };
  }
  if (type === "ws") {
    return {
      type: "ws",
      url: validateAbsoluteCodexWsUrl(
        requiredNonEmptyString(record.url, `${label}.url`),
        `${label}.url`,
      ),
    };
  }
  throw new RequestValidationError(`${label}.type must be one of: stdio, ws`);
}

function optionalBackendSpecific(value: unknown, label: string): BackendSpecificConfig | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, label);
  const allowedKeys = new Set(["codex"]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.${key} is not supported`);
    }
  }

  if (record.codex === undefined) {
    return {};
  }
  const codex = asRecord(record.codex, `${label}.codex`);
  const codexAllowedKeys = new Set(["transport"]);
  for (const key of Object.keys(codex)) {
    if (!codexAllowedKeys.has(key)) {
      throw new RequestValidationError(`${label}.codex.${key} is not supported`);
    }
  }

  return {
    codex: {
      transport: optionalCodexTransport(codex.transport, `${label}.codex.transport`),
    },
  };
}

export function optionalOverrides(value: unknown): RunCommandOverrides {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value, "overrides");
  const allowedKeys = new Set([
    "cwd",
    "backend",
    "launcher",
    "model",
    "effort",
    "message",
    "name",
    "timeoutSec",
    "unrestricted",
    "maxRetries",
    "addedTasks",
    "backendSpecific",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`overrides.${key} is not supported`);
    }
  }
  const launcher = optionalNonEmptyString(record.launcher, "overrides.launcher");
  if (launcher !== undefined && !isNamedLauncherOverride(launcher)) {
    throw new RequestValidationError(
      "overrides.launcher must be a named launcher id, not a path reference",
    );
  }
  return {
    cwd: optionalString(record.cwd, "overrides.cwd"),
    backend: optionalEnum(record.backend, "overrides.backend", BACKEND_IDS),
    launcher,
    model: optionalString(record.model, "overrides.model"),
    effort: optionalEnum(record.effort, "overrides.effort", [
      "off",
      "minimal",
      "low",
      "medium",
      "high",
      "xhigh",
      "max",
    ]),
    message: optionalString(record.message, "overrides.message"),
    name: optionalNonEmptyString(record.name, "overrides.name"),
    timeoutSec: optionalPositiveInteger(record.timeoutSec, "overrides.timeoutSec"),
    unrestricted: optionalBoolean(record.unrestricted, "overrides.unrestricted"),
    maxRetries: optionalNonNegativeInteger(record.maxRetries, "overrides.maxRetries"),
    addedTasks: optionalStringArray(record.addedTasks, "overrides.addedTasks"),
    backendSpecific: optionalBackendSpecific(record.backendSpecific, "overrides.backendSpecific"),
  };
}

export function parseStartRunParams(value: unknown, label: string): RunsStartParams {
  const record = asRecord(value, label);
  return {
    agent: optionalString(record.agent, "agent"),
    assignment: optionalString(record.assignment, "assignment"),
    definitionCwd: optionalString(record.definitionCwd, "definitionCwd"),
    callerCwd: optionalString(record.callerCwd, "callerCwd"),
    backendSessionId: optionalString(record.backendSessionId, "backendSessionId"),
    cliVars: stringRecord(record.cliVars, "cliVars"),
    overrides: optionalOverrides(record.overrides),
  };
}

export function parseRunSetNameParams(value: unknown, label: string): RunSetNameParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    name: requiredNullableRunName(record.name, `${label}.name`),
  };
}

export function parseRunSetNoteParams(value: unknown, label: string): RunSetNoteParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    note: requiredNullableString(record.note, `${label}.note`),
  };
}

export function parseRunSetPinnedParams(value: unknown, label: string): RunSetPinnedParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    pinned: requiredBoolean(record.pinned, `${label}.pinned`),
  };
}

export function parseRunSetBackendSessionParams(
  value: unknown,
  label: string,
): RunSetBackendSessionParams {
  const record = asRecord(value, label);
  return {
    target: requiredString(record.target, `${label}.target`),
    backendSessionId: requiredNonEmptyString(record.backendSessionId, `${label}.backendSessionId`),
  };
}

export function parseRunListScope(value: unknown, label: string): RunListScopeFilter | undefined {
  if (value === undefined) {
    return undefined;
  }
  const record = asRecord(value, label);
  const kind = optionalEnum(record.kind, `${label}.kind`, ["cwd", "repo", "global"]);
  if (kind === undefined) {
    throw new RequestValidationError(`${label}.kind is required`);
  }
  if (kind === "cwd") {
    return {
      kind,
      cwd: requiredString(record.cwd, `${label}.cwd`),
    };
  }
  if (kind === "repo") {
    return {
      kind,
      repo: requiredString(record.repo, `${label}.repo`),
    };
  }
  return { kind };
}

export function parseRunsListParams(value: unknown, label: string): RunsListParams {
  const record = asRecord(value, label);
  return {
    includeArchived: optionalBoolean(record.includeArchived, `${label}.includeArchived`),
    scope: parseRunListScope(record.scope, `${label}.scope`),
  };
}
