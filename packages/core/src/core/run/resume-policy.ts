import type { ManifestStatus, TaskSnapshot } from "./manifest.js";

export const IMPLICIT_RESUME_MESSAGE =
  "Check the task list and continue working through the remaining items.";

export function hasRunnableTasks(finalTasks: Record<string, TaskSnapshot>): boolean {
  return Object.values(finalTasks).some(
    (task) => task.status === "pending" || task.status === "in_progress",
  );
}

export function missingResumeInputMessage(): string {
  return "cannot resume a run with no runnable tasks without either a follow-up message or a newly added task";
}

export function missingBlockedResumeMessage(): string {
  return "cannot resume a blocked run without a follow-up message";
}

export function resumeStatusRequiresExplicitMessage(status: ManifestStatus): boolean {
  return status === "blocked";
}

export function canResumeWithoutMessage(input: {
  finalTasks: Record<string, TaskSnapshot>;
  hasAddedTasks: boolean;
  status: ManifestStatus;
}): boolean {
  if (resumeStatusRequiresExplicitMessage(input.status)) {
    return false;
  }
  return input.hasAddedTasks || hasRunnableTasks(input.finalTasks);
}

function isTerminalStatus(status: ManifestStatus): boolean {
  return (
    status === "success" ||
    status === "blocked" ||
    status === "exhausted" ||
    status === "aborted" ||
    status === "error"
  );
}

export function needsStoppedRunTaskReminder(input: {
  backend: string;
  status: ManifestStatus;
  finalTasks: Record<string, TaskSnapshot>;
}): boolean {
  if (resumeStatusRequiresExplicitMessage(input.status)) {
    return false;
  }
  return (
    input.backend !== "passive" &&
    isTerminalStatus(input.status) &&
    hasRunnableTasks(input.finalTasks)
  );
}
