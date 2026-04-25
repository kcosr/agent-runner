import type { RunAuditEvent } from "@task-runner/core/contracts/events.js";
import type { RunStatus, RunTaskSummary } from "@task-runner/core/contracts/runs.js";
import type { ResolvedHookDescriptor } from "@task-runner/core/hooks";

export type AuditMessagePart =
  | {
      type: "text";
      text: string;
    }
  | {
      type: "code";
      text: string;
    }
  | {
      type: "strong";
      text: string;
    }
  | {
      type: "status";
      status: RunStatus;
    }
  | {
      type: "task_status";
      status: RunTaskSummary["status"];
    };

export interface FormattedAuditEvent {
  message: AuditMessagePart[];
}

export interface AuditFormatContext {
  resolvedHooks?: ResolvedHookDescriptor[];
  tasks?: RunTaskSummary[];
}

function text(value: string): AuditMessagePart {
  return { type: "text", text: value };
}

function code(value: unknown): AuditMessagePart {
  return { type: "code", text: String(value) };
}

function strong(value: unknown): AuditMessagePart {
  return { type: "strong", text: String(value) };
}

function isRunStatus(value: unknown): value is RunStatus {
  return (
    value === "initialized" ||
    value === "ready" ||
    value === "running" ||
    value === "success" ||
    value === "blocked" ||
    value === "exhausted" ||
    value === "aborted" ||
    value === "error"
  );
}

function status(value: unknown): AuditMessagePart {
  return { type: "status", status: isRunStatus(value) ? value : "error" };
}

function isTaskStatus(value: unknown): value is RunTaskSummary["status"] {
  return (
    value === "pending" || value === "in_progress" || value === "completed" || value === "blocked"
  );
}

function taskStatus(value: unknown): AuditMessagePart {
  return { type: "task_status", status: isTaskStatus(value) ? value : "blocked" };
}

function formatTaskCommand(value: unknown): string {
  return value === "append_notes" ? "append-notes" : String(value ?? "unknown");
}

function nullableCode(value: unknown, fallback = "none"): AuditMessagePart {
  return code(value ?? fallback);
}

function scheduleRunAt(value: unknown): string {
  if (!value || typeof value !== "object") {
    return "unknown";
  }
  const schedule = value as Record<string, unknown>;
  return typeof schedule.runAt === "string" ? schedule.runAt : "unknown";
}

function formatScheduleReason(value: unknown): string {
  switch (value) {
    case "dependencies_unmet":
      return "dependencies unmet";
    case "overdue_on_startup":
      return "overdue on startup";
    case "already_active":
      return "already active";
    case "archived":
      return "archived";
    case "not_ready":
      return "not ready";
    case "minimum_interval_violation":
      return "minimum interval violation";
    default:
      return String(value ?? "unknown");
  }
}

function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function punctuationSuffix(value: string): string {
  return /[.!?]$/.test(value) ? "" : ".";
}

function taskLabel(taskId: unknown, context?: AuditFormatContext): string | null {
  const id = asString(taskId);
  if (!id) {
    return null;
  }
  const task = context?.tasks?.find((entry) => entry.id === id);
  return task?.title ?? id;
}

function pathBasename(value: string | null | undefined): string | null {
  if (!value) {
    return null;
  }
  const segments = value.split(/[\\/]/).filter(Boolean);
  return segments.at(-1) ?? null;
}

function hookLabel(hookId: unknown, context?: AuditFormatContext): string {
  const id = asString(hookId) ?? "unknown";
  const descriptor = context?.resolvedHooks?.find((entry) => entry.hookId === id);
  return (
    descriptor?.source.builtin ??
    descriptor?.source.name ??
    pathBasename(descriptor?.resolvedPath) ??
    (id.split(":").at(-1) as string)
  );
}

function hookSummarySuffix(fields: Record<string, unknown>): AuditMessagePart[] {
  const summary = asString(fields.summary);
  if (!summary) {
    return [text(".")];
  }
  return [text(": "), text(summary), text(punctuationSuffix(summary))];
}

function formatHookAuditEvent(
  event: RunAuditEvent,
  context?: AuditFormatContext,
): FormattedAuditEvent {
  const fields = event.fields;
  const name = hookLabel(fields.hookId, context);
  const phase = asString(fields.phase) ?? "unknown";
  const outcome = asString(fields.outcome) ?? "unknown";
  const task = taskLabel(fields.taskId, context);

  if (phase === "taskTransition" && task) {
    switch (outcome) {
      case "accepted":
        return {
          message: [
            text("Hook "),
            code(name),
            text(" accepted task transition for "),
            strong(task),
            text("."),
          ],
        };
      case "rejected":
        return {
          message: [
            text("Hook "),
            code(name),
            text(" rejected task transition for "),
            strong(task),
            ...hookSummarySuffix(fields),
          ],
        };
      case "error":
        return {
          message: [
            text("Hook "),
            code(name),
            text(" errored during task transition for "),
            strong(task),
            ...hookSummarySuffix(fields),
          ],
        };
      case "skipped":
        return {
          message: [
            text("Hook "),
            code(name),
            text(" skipped task transition for "),
            strong(task),
            text("."),
          ],
        };
    }
  }

  switch (outcome) {
    case "block":
      return {
        message: [
          text("Hook "),
          code(name),
          text(" blocked during "),
          code(phase),
          ...hookSummarySuffix(fields),
        ],
      };
    case "error":
      return {
        message: [
          text("Hook "),
          code(name),
          text(" errored during "),
          code(phase),
          ...hookSummarySuffix(fields),
        ],
      };
    case "skipped":
      return {
        message: [text("Hook "), code(name), text(" skipped during "), code(phase), text(".")],
      };
    case "reinvoke":
      return {
        message: [text("Hook "), code(name), text(" reinvoked during "), code(phase), text(".")],
      };
    case "continue":
      return {
        message: [text("Hook "), code(name), text(" ran during "), code(phase), text(".")],
      };
    default:
      return {
        message: [
          text("Hook "),
          code(name),
          text(" ran during "),
          code(phase),
          text(" with outcome "),
          code(outcome),
          ...hookSummarySuffix(fields),
        ],
      };
  }
}

export function formatAuditEvent(
  event: RunAuditEvent,
  context?: AuditFormatContext,
): FormattedAuditEvent {
  const fields = event.fields;
  switch (event.type) {
    case "run.created":
      return {
        message: [
          text("Created run "),
          strong(fields.name ?? fields.assignmentName ?? event.type),
          text(" with backend "),
          code(fields.backend ?? "unknown"),
          text("."),
        ],
      };
    case "run.started":
      return {
        message: [text("Started run with session "), code(event.sessionIndex ?? 0), text(".")],
      };
    case "run.resumed":
      return {
        message: [text("Resumed run with session "), code(event.sessionIndex ?? 0), text(".")],
      };
    case "run.ready":
      return {
        message: [
          text("Marked run ready from "),
          status(fields.previousStatus ?? "initialized"),
          text("."),
        ],
      };
    case "run.backend_session_updated":
      return {
        message: [
          text("Updated backend session from "),
          nullableCode(fields.previousBackendSessionId),
          text(" to "),
          nullableCode(fields.nextBackendSessionId),
          text(" ("),
          code(fields.reason ?? "unknown"),
          text(")."),
        ],
      };
    case "run.hook_recorded":
      return formatHookAuditEvent(event, context);
    case "run.attempt_recorded":
      return {
        message: [
          text("Recorded attempt "),
          code(event.attemptNumber ?? "?"),
          text(" in session "),
          code(event.sessionIndex ?? 0),
          text(" with exit code "),
          nullableCode(fields.exitCode),
          text("."),
        ],
      };
    case "run.retrying":
      return {
        message: [
          text("Retrying after session "),
          code(event.sessionIndex ?? 0),
          text(" with "),
          code(fields.incompleteCount ?? 0),
          text(" incomplete and "),
          code(fields.invalidStatusCount ?? 0),
          text(" invalid task statuses."),
        ],
      };
    case "run.finished":
      return {
        message: [
          text("Finished run as "),
          status(fields.terminalStatus ?? "unknown"),
          text(" with "),
          code(fields.tasksCompleted ?? 0),
          text("/"),
          code(fields.tasksTotal ?? 0),
          text(" tasks complete."),
        ],
      };
    case "run.aborted":
      return {
        message: [text("Aborted run during session "), code(event.sessionIndex ?? 0), text(".")],
      };
    case "run.resume_rejected":
      return {
        message: [
          text("Rejected resume during session "),
          code(event.sessionIndex ?? 0),
          text("."),
        ],
      };
    case "run.reset":
      return {
        message: [text("Reset run from "), status(fields.previousStatus ?? "unknown"), text(".")],
      };
    case "run.archived":
      return {
        message: [text("Archived run.")],
      };
    case "run.unarchived":
      return {
        message: [text("Unarchived run.")],
      };
    case "run.renamed":
      return {
        message: [
          text("Renamed run from "),
          nullableCode(fields.previousName, "unnamed"),
          text(" to "),
          nullableCode(fields.nextName, "unnamed"),
          text("."),
        ],
      };
    case "run.schedule_set":
      return {
        message: [text("Set schedule for "), code(scheduleRunAt(fields.schedule)), text(".")],
      };
    case "run.schedule_cleared":
      return {
        message: [
          text("Cleared schedule that was set for "),
          code(scheduleRunAt(fields.previousSchedule)),
          text("."),
        ],
      };
    case "run.schedule_enabled":
      return {
        message: [text("Enabled schedule for "), code(scheduleRunAt(fields.schedule)), text(".")],
      };
    case "run.schedule_disabled":
      return {
        message: [
          text("Disabled schedule for "),
          code(scheduleRunAt(fields.schedule)),
          text(" ("),
          code(formatScheduleReason(fields.reason)),
          text(")."),
        ],
      };
    case "run.schedule_due":
      return {
        message: [
          text("Schedule became due for "),
          code(scheduleRunAt(fields.schedule)),
          text("."),
        ],
      };
    case "run.schedule_missed":
      return {
        message: [
          text("Missed schedule for "),
          code(scheduleRunAt(fields.schedule)),
          text(" ("),
          code(formatScheduleReason(fields.reason)),
          text(")."),
        ],
      };
    case "run.schedule_skipped":
      return {
        message: [
          text("Skipped schedule for "),
          code(scheduleRunAt(fields.schedule)),
          text(" ("),
          code(formatScheduleReason(fields.reason)),
          text(")."),
        ],
      };
    case "run.schedule_failed":
      return {
        message: [
          text("Schedule failed for "),
          code(scheduleRunAt(fields.schedule)),
          text(" ("),
          code(formatScheduleReason(fields.reason)),
          text(")."),
        ],
      };
    case "run.schedule_advanced":
      return {
        message: [
          text("Advanced schedule from "),
          code(scheduleRunAt(fields.previousSchedule)),
          text(" to "),
          code(scheduleRunAt(fields.schedule)),
          text(fields.reason === undefined ? "." : ` (${formatScheduleReason(fields.reason)}).`),
        ],
      };
    case "run.schedule_consumed":
      return {
        message: [text("Consumed schedule for "), code(scheduleRunAt(fields.schedule)), text(".")],
      };
    case "task.added":
      return {
        message: [
          text("Added task "),
          strong(fields.taskTitle ?? fields.taskId ?? "unknown"),
          text("."),
        ],
      };
    case "task.updated":
      if (isTaskStatus(fields.statusBefore) && isTaskStatus(fields.statusAfter)) {
        return {
          message: [
            text("Updated task "),
            strong(fields.taskTitle ?? fields.taskId ?? "unknown"),
            text(" from "),
            taskStatus(fields.statusBefore),
            text(" to "),
            taskStatus(fields.statusAfter),
            text(" via "),
            code(formatTaskCommand(fields.command)),
            text("."),
          ],
        };
      }
      if (isTaskStatus(fields.statusAfter)) {
        return {
          message: [
            text("Set task "),
            strong(fields.taskTitle ?? fields.taskId ?? "unknown"),
            text(" to "),
            taskStatus(fields.statusAfter),
            text(" via "),
            code(formatTaskCommand(fields.command)),
            text("."),
          ],
        };
      }
      if (fields.notesChanged === true) {
        return {
          message: [
            text("Updated notes on task "),
            strong(fields.taskTitle ?? fields.taskId ?? "unknown"),
            text(" via "),
            code(formatTaskCommand(fields.command)),
            text("."),
          ],
        };
      }
      return {
        message: [
          text("Updated task "),
          strong(fields.taskTitle ?? fields.taskId ?? "unknown"),
          text(" via "),
          code(formatTaskCommand(fields.command)),
          text("."),
        ],
      };
    default:
      return {
        message: [text("Recorded "), code(event.type), text(".")],
      };
  }
}
