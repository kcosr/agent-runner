import type { RunTimelineAuditEvent } from "@task-runner/core/contracts/events.js";

export type AuditFilterCategory = "All" | "Hooks" | "Tasks" | "Lifecycle" | "Backend";
export type AuditCategoryLabel = "Run" | "Task" | "Hook" | "Backend";

export interface FormattedAuditEvent {
  sentence: string;
  filterCategory: Exclude<AuditFilterCategory, "All">;
  categoryLabel: AuditCategoryLabel;
}

export function formatAuditEventRow(event: RunTimelineAuditEvent): FormattedAuditEvent {
  const auditEvent = event.event;
  switch (auditEvent.type) {
    case "run.created":
      return { sentence: "Run initialized.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.ready":
      return { sentence: "Run marked ready.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.started":
      return {
        sentence: "Run attempt session started.",
        filterCategory: "Lifecycle",
        categoryLabel: "Run",
      };
    case "run.resumed":
      return { sentence: "Run resumed.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.retrying":
      return {
        sentence: "Retrying execution.",
        filterCategory: "Lifecycle",
        categoryLabel: "Run",
      };
    case "run.finished":
      return {
        sentence: `Run finished with status ${String(auditEvent.terminalStatus ?? "unknown")}.`,
        filterCategory: "Lifecycle",
        categoryLabel: "Run",
      };
    case "run.resume_rejected":
      return {
        sentence: "Backend rejected resume request; aborting.",
        filterCategory: "Lifecycle",
        categoryLabel: "Run",
      };
    case "run.aborted":
      return { sentence: "Run aborted.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.reset":
      return { sentence: "Run reset.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.archived":
      return { sentence: "Run archived.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.unarchived":
      return { sentence: "Run unarchived.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.renamed":
      return { sentence: "Run renamed.", filterCategory: "Lifecycle", categoryLabel: "Run" };
    case "run.backend_session_updated":
      return {
        sentence: "Backend session updated.",
        filterCategory: "Backend",
        categoryLabel: "Backend",
      };
    case "run.attempt_recorded":
      return {
        sentence: `Attempt ${typeof auditEvent.attempt === "number" ? auditEvent.attempt : "?"} recorded.`,
        filterCategory: "Backend",
        categoryLabel: "Backend",
      };
    case "task.added":
      return {
        sentence: `Task \`${String(auditEvent.taskId ?? "?")}\` added: ${String(auditEvent.taskTitle ?? "Untitled")}.`,
        filterCategory: "Tasks",
        categoryLabel: "Task",
      };
    case "task.updated":
      return {
        sentence:
          typeof auditEvent.statusAfter === "string"
            ? `Task \`${String(auditEvent.taskId ?? "?")}\` marked ${auditEvent.statusAfter}.`
            : `Task \`${String(auditEvent.taskId ?? "?")}\` updated.`,
        filterCategory: "Tasks",
        categoryLabel: "Task",
      };
    case "run.hook_recorded": {
      const hookId = String(auditEvent.hookId ?? "?");
      const outcome = String(auditEvent.outcome ?? "recorded");
      switch (auditEvent.phase) {
        case "prepare":
          return {
            sentence: `Prepare hook \`${hookId}\` ${outcome}.`,
            filterCategory: "Hooks",
            categoryLabel: "Hook",
          };
        case "beforeAttempt":
          return {
            sentence: `Before-attempt hook \`${hookId}\` ${outcome}.`,
            filterCategory: "Hooks",
            categoryLabel: "Hook",
          };
        case "taskTransition":
          return {
            sentence: `Task-transition hook \`${hookId}\` ${outcome} for task \`${String(auditEvent.taskId ?? "?")}\`.`,
            filterCategory: "Hooks",
            categoryLabel: "Hook",
          };
        case "afterAttempt":
          return {
            sentence: `After-attempt hook \`${hookId}\` ${outcome}.`,
            filterCategory: "Hooks",
            categoryLabel: "Hook",
          };
        case "afterExit":
          return {
            sentence: `After-exit hook \`${hookId}\` ${outcome}.`,
            filterCategory: "Hooks",
            categoryLabel: "Hook",
          };
        default:
          return {
            sentence: `Hook \`${hookId}\` ${outcome}.`,
            filterCategory: "Hooks",
            categoryLabel: "Hook",
          };
      }
    }
    default:
      return {
        sentence: `Unhandled audit event ${auditEvent.type} at cursor ${event.cursor}.`,
        filterCategory: "Lifecycle",
        categoryLabel: "Run",
      };
  }
}

export function matchesAuditFilter(
  event: RunTimelineAuditEvent,
  filter: AuditFilterCategory,
): boolean {
  if (filter === "All") {
    return true;
  }
  return formatAuditEventRow(event).filterCategory === filter;
}
