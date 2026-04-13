import type { RunCommandOverrides } from "../app/service.js";

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

export function requiredString(value: unknown, label: string): string {
  const stringValue = optionalString(value, label);
  if (stringValue === undefined) {
    throw new RequestValidationError(`${label} is required`);
  }
  return stringValue;
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

export function optionalOverrides(value: unknown): RunCommandOverrides {
  if (value === undefined) {
    return {};
  }
  const record = asRecord(value, "overrides");
  const allowedKeys = new Set([
    "cwd",
    "backend",
    "model",
    "effort",
    "taskMode",
    "message",
    "sessionName",
    "timeoutSec",
    "unrestricted",
    "maxRetries",
    "addedTasks",
  ]);
  for (const key of Object.keys(record)) {
    if (!allowedKeys.has(key)) {
      throw new RequestValidationError(`overrides.${key} is not supported`);
    }
  }
  return {
    cwd: optionalString(record.cwd, "overrides.cwd"),
    backend: optionalEnum(record.backend, "overrides.backend", ["claude", "codex", "passive"]),
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
    taskMode: optionalEnum(record.taskMode, "overrides.taskMode", ["file", "cli"]),
    message: optionalString(record.message, "overrides.message"),
    sessionName: optionalString(record.sessionName, "overrides.sessionName"),
    timeoutSec: optionalPositiveInteger(record.timeoutSec, "overrides.timeoutSec"),
    unrestricted: optionalBoolean(record.unrestricted, "overrides.unrestricted"),
    maxRetries: optionalNonNegativeInteger(record.maxRetries, "overrides.maxRetries"),
    addedTasks: optionalStringArray(record.addedTasks, "overrides.addedTasks"),
  };
}
