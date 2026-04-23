import { performance } from "node:perf_hooks";

export const TASK_RUNNER_DEBUG_PERF_ENV = "TASK_RUNNER_DEBUG_PERF";
export const TASK_RUNNER_DEBUG_PERF_INTERVAL_MS_ENV = "TASK_RUNNER_DEBUG_PERF_INTERVAL_MS";

type DebugPerfFields = Record<string, unknown>;
type DebugPerfTimer = (extraFields?: DebugPerfFields) => void;

const NOOP_DEBUG_PERF_TIMER: DebugPerfTimer = () => {};

function normalizeEnabled(value: string | undefined): boolean {
  if (!value) {
    return false;
  }
  const normalized = value.trim().toLowerCase();
  return normalized !== "" && normalized !== "0" && normalized !== "false" && normalized !== "off";
}

function roundDurationMs(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

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
  const entries = Object.entries(fields).filter(([, value]) => value !== undefined);
  if (entries.length === 0) {
    return "";
  }
  return ` ${entries.map(([key, value]) => `${key}=${formatFieldValue(value)}`).join(" ")}`;
}

export function debugPerfEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return normalizeEnabled(env[TASK_RUNNER_DEBUG_PERF_ENV]);
}

export function readDebugPerfIntervalMs(
  env: NodeJS.ProcessEnv = process.env,
  fallbackMs = 5_000,
): number {
  const raw = env[TASK_RUNNER_DEBUG_PERF_INTERVAL_MS_ENV];
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
  const line = `[task-runner perf] ${new Date().toISOString()} ${event}${formatFields(fields)}\n`;
  process.stderr.write(line);
}

export function startDebugPerfTimer(
  event: string,
  fields: DebugPerfFields = {},
  env: NodeJS.ProcessEnv = process.env,
): DebugPerfTimer {
  if (!debugPerfEnabled(env)) {
    return NOOP_DEBUG_PERF_TIMER;
  }
  const startedAt = performance.now();
  return (extraFields: DebugPerfFields = {}) => {
    debugPerfLog(
      event,
      {
        ...fields,
        ...extraFields,
        durationMs: roundDurationMs(performance.now() - startedAt),
      },
      env,
    );
  };
}
