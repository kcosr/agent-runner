import { CronExpressionParser } from "cron-parser";
import cronstrue from "cronstrue";
import type { RunSchedule, RunScheduleMode, RunScheduleRecurrence } from "./manifest.js";

export interface ScheduleInput {
  at?: string;
  delay?: string;
  cron?: string;
  timezone?: string;
  mode?: RunScheduleMode;
  continueOnFailure?: boolean;
}

export interface ScheduleResolutionOptions {
  now?: Date;
  env?: NodeJS.ProcessEnv;
}

export interface RecurrenceAdvanceResult {
  schedule: RunSchedule;
  disabledReason: "minimum_interval_violation" | null;
}

const DEFAULT_MIN_SCHEDULE_DELAY_SEC = 300;
const DEFAULT_MIN_RECURRENCE_INTERVAL_SEC = 300;
const RECURRENCE_SAMPLE_SIZE = 10;
const MAX_DATE_MS = 8_640_000_000_000_000;
const DURATION_PATTERN =
  /^([1-9][0-9]*)\s*(s|sec|secs|second|seconds|m|min|mins|minute|minutes|h|hr|hrs|hour|hours|d|day|days)$/i;

export class ScheduleValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleValidationError";
  }
}

export type RunScheduleState = "none" | "paused" | "future" | "due";

export function deriveScheduleState(
  schedule: RunSchedule | null,
  now: Date = new Date(),
): RunScheduleState {
  if (schedule === null) return "none";
  if (!schedule.enabled) return "paused";
  return new Date(schedule.runAt).getTime() <= now.getTime() ? "due" : "future";
}

export function resolveScheduleInput(
  input: ScheduleInput,
  options: ScheduleResolutionOptions = {},
): RunSchedule {
  const now = options.now ?? new Date();
  const sourceCount = [input.at, input.delay, input.cron].filter(
    (value) => value !== undefined,
  ).length;
  if (sourceCount !== 1) {
    throw new ScheduleValidationError("schedule requires exactly one of at, delay, or cron");
  }

  if (input.cron === undefined) {
    validateOneTimeOnlyFields(input);
    const runAt = input.at !== undefined ? parseRunAt(input.at) : resolveDelay(input.delay, now);
    enforceMinimumScheduleDelay(runAt, now, options.env);
    return {
      enabled: true,
      runAt: runAt.toISOString(),
      recurrence: null,
    };
  }

  const timezone = input.timezone ?? resolveLocalTimezone();
  validateTimezone(timezone);
  const recurrence: RunScheduleRecurrence = {
    schedule: {
      type: "cron",
      expression: input.cron,
      timezone,
    },
    mode: input.mode ?? "clone",
    continueOnFailure: input.continueOnFailure ?? false,
  };
  const runAt = computeNextCronRunAt(recurrence.schedule.expression, timezone, now);
  validateRecurrenceMinimumInterval(recurrence, runAt, options.env);
  return {
    enabled: true,
    runAt: runAt.toISOString(),
    recurrence,
  };
}

export function advanceRecurringSchedule(
  schedule: RunSchedule,
  now: Date = new Date(),
  env: NodeJS.ProcessEnv = process.env,
): RecurrenceAdvanceResult {
  if (schedule.recurrence === null) {
    throw new ScheduleValidationError("cannot advance a one-time schedule");
  }
  const nextRunAt = computeNextCronRunAt(
    schedule.recurrence.schedule.expression,
    schedule.recurrence.schedule.timezone,
    now,
  );
  const minimumObservedIntervalSec = smallestObservedIntervalSec(
    schedule.recurrence,
    nextRunAt,
  );
  if (minimumObservedIntervalSec < getMinimumRecurrenceIntervalSec(env)) {
    return {
      schedule: {
        ...schedule,
        enabled: false,
      },
      disabledReason: "minimum_interval_violation",
    };
  }
  return {
    schedule: {
      ...schedule,
      enabled: true,
      runAt: nextRunAt.toISOString(),
    },
    disabledReason: null,
  };
}

export function formatSchedule(schedule: RunSchedule): string {
  if (schedule.recurrence === null) {
    return `One-time at ${schedule.runAt}`;
  }
  const human = humanizeCronExpression(schedule.recurrence.schedule.expression);
  return `${human} - ${schedule.recurrence.schedule.timezone}`;
}

export function humanizeCronExpression(expression: string): string {
  try {
    return cronstrue.toString(expression);
  } catch {
    return `Cron: ${expression}`;
  }
}

export function computeNextCronRunAt(expression: string, timezone: string, now: Date): Date {
  try {
    return CronExpressionParser.parse(expression, {
      currentDate: now,
      tz: timezone,
    })
      .next()
      .toDate();
  } catch (err) {
    throw new ScheduleValidationError(
      `invalid cron expression "${expression}": ${(err as Error).message}`,
    );
  }
}

export function validateRecurrenceMinimumInterval(
  recurrence: RunScheduleRecurrence,
  startAt: Date,
  env: NodeJS.ProcessEnv = process.env,
): number {
  const observed = smallestObservedIntervalSec(recurrence, startAt);
  const minimum = getMinimumRecurrenceIntervalSec(env);
  if (observed < minimum) {
    throw new ScheduleValidationError(
      `cron recurrence interval ${observed}s is below minimum ${minimum}s`,
    );
  }
  return observed;
}

function smallestObservedIntervalSec(
  recurrence: RunScheduleRecurrence,
  startAt: Date,
): number {
  const dates = sampleFutureOccurrences(recurrence, startAt);
  let smallest = Number.POSITIVE_INFINITY;
  for (let index = 1; index < dates.length; index += 1) {
    const current = dates[index];
    const previous = dates[index - 1];
    if (current === undefined || previous === undefined) {
      continue;
    }
    const deltaSec = (current.getTime() - previous.getTime()) / 1000;
    smallest = Math.min(smallest, deltaSec);
  }
  return smallest;
}

export function sampleFutureOccurrences(
  recurrence: RunScheduleRecurrence,
  startAt: Date,
): Date[] {
  try {
    const interval = CronExpressionParser.parse(recurrence.schedule.expression, {
      currentDate: startAt,
      tz: recurrence.schedule.timezone,
    });
    return [startAt, ...interval.take(RECURRENCE_SAMPLE_SIZE - 1).map((date) => date.toDate())];
  } catch (err) {
    throw new ScheduleValidationError(
      `invalid cron expression "${recurrence.schedule.expression}": ${(err as Error).message}`,
    );
  }
}

function validateOneTimeOnlyFields(input: ScheduleInput): void {
  if (input.timezone !== undefined) {
    throw new ScheduleValidationError("timezone is valid only with cron schedules");
  }
  if (input.mode !== undefined) {
    throw new ScheduleValidationError("mode is valid only with cron schedules");
  }
  if (input.continueOnFailure !== undefined) {
    throw new ScheduleValidationError("continueOnFailure is valid only with cron schedules");
  }
}

function parseRunAt(value: string): Date {
  const runAt = new Date(value);
  if (Number.isNaN(runAt.getTime())) {
    throw new ScheduleValidationError(`invalid schedule timestamp "${value}"`);
  }
  return runAt;
}

function resolveDelay(value: string | undefined, now: Date): Date {
  if (value === undefined) {
    throw new ScheduleValidationError("delay is required");
  }
  const runAtMs = now.getTime() + parseDurationMs(value);
  if (!Number.isFinite(runAtMs) || runAtMs > MAX_DATE_MS) {
    throw new ScheduleValidationError(`schedule delay "${value}" is too large`);
  }
  return new Date(runAtMs);
}

export function parseDurationMs(value: string): number {
  const match = DURATION_PATTERN.exec(value.trim());
  if (!match) {
    throw new ScheduleValidationError(`invalid schedule delay "${value}"`);
  }
  const [, rawAmount, rawUnit] = match;
  if (rawAmount === undefined || rawUnit === undefined) {
    throw new ScheduleValidationError(`invalid schedule delay "${value}"`);
  }
  const amount = Number(rawAmount);
  if (!Number.isSafeInteger(amount)) {
    throw new ScheduleValidationError(`schedule delay "${value}" is too large`);
  }
  const unit = rawUnit.toLowerCase();
  const multiplier = unit.startsWith("s")
    ? 1000
    : unit.startsWith("m")
      ? 60 * 1000
      : unit.startsWith("h")
        ? 60 * 60 * 1000
        : 24 * 60 * 60 * 1000;
  const durationMs = amount * multiplier;
  if (!Number.isSafeInteger(durationMs)) {
    throw new ScheduleValidationError(`schedule delay "${value}" is too large`);
  }
  return durationMs;
}

function enforceMinimumScheduleDelay(
  runAt: Date,
  now: Date,
  env: NodeJS.ProcessEnv = process.env,
): void {
  const minimum = getMinimumScheduleDelaySec(env);
  const runAtMs = runAt.getTime();
  const nowMs = now.getTime();
  if (!Number.isFinite(runAtMs) || !Number.isFinite(nowMs)) {
    throw new ScheduleValidationError("invalid schedule timestamp");
  }
  const delaySec = (runAtMs - nowMs) / 1000;
  if (delaySec < minimum) {
    throw new ScheduleValidationError(
      `schedule delay ${Math.floor(delaySec)}s is below minimum ${minimum}s`,
    );
  }
}

function getMinimumScheduleDelaySec(env: NodeJS.ProcessEnv): number {
  return readPositiveIntegerEnv(
    env.TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC,
    "TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC",
    DEFAULT_MIN_SCHEDULE_DELAY_SEC,
  );
}

function getMinimumRecurrenceIntervalSec(env: NodeJS.ProcessEnv): number {
  return readPositiveIntegerEnv(
    env.TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC,
    "TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC",
    DEFAULT_MIN_RECURRENCE_INTERVAL_SEC,
  );
}

function readPositiveIntegerEnv(value: string | undefined, name: string, fallback: number): number {
  if (value === undefined || value.trim().length === 0) return fallback;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new ScheduleValidationError(`${name} must be a positive integer`);
  }
  return parsed;
}

function resolveLocalTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

function validateTimezone(timezone: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone }).format(new Date());
  } catch {
    throw new ScheduleValidationError(`invalid schedule timezone "${timezone}"`);
  }
}
