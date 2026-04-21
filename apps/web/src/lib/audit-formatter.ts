import type { RunAuditEvent } from "@task-runner/core/contracts/events.js";
import type { RunStatus } from "@task-runner/core/contracts/runs.js";

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
    };

export interface FormattedAuditEvent {
  message: AuditMessagePart[];
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

function nullableCode(value: unknown, fallback = "none"): AuditMessagePart {
  return code(value ?? fallback);
}

export function formatAuditEvent(event: RunAuditEvent): FormattedAuditEvent {
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
      return {
        message: [
          text("Recorded hook "),
          code(fields.hookId ?? "unknown"),
          text(" for "),
          strong(fields.phase ?? "unknown"),
          text(" with outcome "),
          code(fields.outcome ?? "unknown"),
          text("."),
        ],
      };
    case "run.attempt_recorded":
      return {
        message: [
          text("Recorded attempt "),
          code(event.attempt ?? "?"),
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
    case "task.added":
      return {
        message: [
          text("Added task "),
          strong(fields.taskTitle ?? fields.taskId ?? "unknown"),
          text("."),
        ],
      };
    case "task.updated":
      return {
        message: [
          text("Updated task "),
          strong(fields.taskTitle ?? fields.taskId ?? "unknown"),
          text(" via "),
          code(fields.command ?? "unknown"),
          text("."),
        ],
      };
    default:
      return {
        message: [text("Recorded "), code(event.type), text(".")],
      };
  }
}
