import type { RunSchedule, RunScheduleState } from "@kcosr/agent-runner-core/contracts/runs.js";
import type { RunScheduleMode } from "@kcosr/agent-runner-core/core/run/manifest.js";
import { humanizeCronExpression } from "@kcosr/agent-runner-core/core/run/schedule.js";

const TIMESTAMP_FORMATTER = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const RELATIVE_TIMESTAMP_FORMATTER = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });

export function formatTimestamp(value: string | null): string {
  if (!value) {
    return "Not available";
  }

  return TIMESTAMP_FORMATTER.format(new Date(value));
}

export function formatRelativeTimestamp(value: string | null): string {
  if (!value) {
    return "";
  }

  const deltaMs = new Date(value).getTime() - Date.now();
  const deltaMinutes = Math.round(deltaMs / 60_000);

  if (Math.abs(deltaMinutes) < 60) {
    return RELATIVE_TIMESTAMP_FORMATTER.format(deltaMinutes, "minute");
  }

  const deltaHours = Math.round(deltaMinutes / 60);
  if (Math.abs(deltaHours) < 48) {
    return RELATIVE_TIMESTAMP_FORMATTER.format(deltaHours, "hour");
  }

  return RELATIVE_TIMESTAMP_FORMATTER.format(Math.round(deltaHours / 24), "day");
}

export function formatTimestampWithRelative(value: string | null): string {
  const absolute = formatTimestamp(value);
  const relative = formatRelativeTimestamp(value);
  return relative ? `${absolute} ${relative}` : absolute;
}

export function truncateEnd(value: string, max = 44): string {
  if (value.length <= max) {
    return value;
  }
  return `${value.slice(0, Math.max(0, max - 3))}...`;
}

export function formatScheduleState(state: RunScheduleState): string {
  switch (state) {
    case "none":
      return "Not scheduled";
    case "paused":
      return "Paused";
    case "future":
      return "Scheduled";
    case "due":
      return "Due";
  }
}

export function formatScheduleKind(schedule: RunSchedule): string {
  return schedule.recurrence === null ? "One-time" : "Recurring";
}

export function formatScheduleMode(mode: RunScheduleMode): string {
  switch (mode) {
    case "reuse":
      return "Reuse run";
    case "reset":
      return "Reset run";
    case "clone":
      return "Clone run";
    default:
      return mode;
  }
}

export function formatScheduleRecurrence(schedule: RunSchedule): string {
  if (schedule.recurrence === null) {
    return "One-time";
  }
  return humanizeCronExpression(schedule.recurrence.schedule.expression);
}

const BYTE_UNITS = ["B", "KB", "MB", "GB", "TB"] as const;

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes < 0) {
    return "0 B";
  }
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const precision = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  return `${value.toFixed(precision)} ${BYTE_UNITS[unit]}`;
}
