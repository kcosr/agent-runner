import type { TaskSnapshot } from "./manifest.js";

export const IMPLICIT_RESUME_MESSAGE = "Continue working through the remaining task list items.";

export function hasRunnableTasks(finalTasks: Record<string, TaskSnapshot>): boolean {
  return Object.values(finalTasks).some(
    (task) => task.status === "pending" || task.status === "in_progress",
  );
}

export function missingResumeInputMessage(): string {
  return "cannot resume a run with no runnable tasks without either a follow-up message or a newly added task";
}
