import { performance } from "node:perf_hooks";

export const AGENT_RUNNER_DEBUG_PERF_ENV = "AGENT_RUNNER_DEBUG_PERF";
export const AGENT_RUNNER_DEBUG_PERF_INTERVAL_MS_ENV = "AGENT_RUNNER_DEBUG_PERF_INTERVAL_MS";

type DebugPerfFields = Record<string, unknown>;
type DebugPerfTimer = (extraFields?: DebugPerfFields) => void;

const NOOP_DEBUG_PERF_TIMER: DebugPerfTimer = () => {};
const FALSEY_DEBUG_VALUES = new Set(["", "0", "false", "off", "no"]);

function normalizeEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return !FALSEY_DEBUG_VALUES.has(normalized);
}

function roundDurationMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const PERF_FIELD_PRIORITY = new Map(
  [
    "durationMs",
    "queuedMs",
    "waitMs",
    "holdMs",
    "retries",
    "utilization",
    "active",
    "idle",
    "minMs",
    "meanMs",
    "maxMs",
    "p99Ms",
    "statusCode",
    "published",
    "subscriberCount",
    "eventCount",
    "attemptCount",
    "taskCount",
    "dependencyCount",
    "dependencyTotal",
    "dependencyUnsatisfied",
    "lastCursor",
    "cursor",
  ].map((key, index) => [key, index]),
);

function formatFieldValue(value: unknown): string {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : JSON.stringify(value);
  }
  if (typeof value === "boolean" || typeof value === "bigint") {
    return String(value);
  }
  if (typeof value === "string") {
    return JSON.stringify(value);
  }
  if (value instanceof Error) {
    return JSON.stringify(value.stack ?? value.message);
  }
  return JSON.stringify(value);
}

function formatFields(fields: DebugPerfFields): string {
  const entries = Object.entries(fields)
    .filter(([, value]) => value !== undefined)
    .sort(([leftKey, leftValue], [rightKey, rightValue]) => {
      const leftPriority = PERF_FIELD_PRIORITY.get(leftKey);
      const rightPriority = PERF_FIELD_PRIORITY.get(rightKey);
      if (leftPriority !== undefined || rightPriority !== undefined) {
        return (
          (leftPriority ?? Number.MAX_SAFE_INTEGER) - (rightPriority ?? Number.MAX_SAFE_INTEGER)
        );
      }

      const classify = (value: unknown): number => {
        if (typeof value === "number" || typeof value === "boolean" || typeof value === "bigint") {
          return 0;
        }
        if (value === null) {
          return 1;
        }
        return 2;
      };

      const categoryDelta = classify(leftValue) - classify(rightValue);
      if (categoryDelta !== 0) {
        return categoryDelta;
      }
      return leftKey.localeCompare(rightKey);
    });
  if (entries.length === 0) {
    return "";
  }
  return ` ${entries.map(([key, value]) => `${key}=${formatFieldValue(value)}`).join(" ")}`;
}

function writeDebugPerfLog(event: string, fields: DebugPerfFields): void {
  const line = `[agent-runner perf] ${new Date().toISOString()} ${event}${formatFields(fields)}\n`;
  process.stderr.write(line);
}

export function debugPerfEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return normalizeEnabled(env[AGENT_RUNNER_DEBUG_PERF_ENV]);
}

export function readDebugPerfIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = 5_000,
): number {
  const raw = env[AGENT_RUNNER_DEBUG_PERF_INTERVAL_MS_ENV];
  if (!raw) {
    return fallbackMs;
  }
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallbackMs;
}

export function debugPerfLog(
  event: string,
  fields: DebugPerfFields = {},
  env: NodeJS.ProcessEnv = process.env,
): void {
  if (!debugPerfEnabled(env)) {
    return;
  }
  writeDebugPerfLog(event, fields);
}

export function startDebugPerfTimer(
  event: string,
  fields: DebugPerfFields = {},
  env: NodeJS.ProcessEnv = process.env,
): DebugPerfTimer {
  const enabled = debugPerfEnabled(env);
  if (!enabled) {
    return NOOP_DEBUG_PERF_TIMER;
  }
  const startedAt = performance.now();
  return (extraFields: DebugPerfFields = {}) => {
    writeDebugPerfLog(event, {
      ...fields,
      ...extraFields,
      durationMs: roundDurationMs(performance.now() - startedAt),
    });
  };
}
