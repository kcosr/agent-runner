import type { TaskSnapshot } from "./manifest.js";

export const IMPLICIT_RESUME_MESSAGE = "Continue working through the remaining task list items.";

export function hasIncompleteTasks(finalTasks: Record<string, TaskSnapshot>): boolean {
  return Object.values(finalTasks).some((task) => task.status !== "completed");
}

export function missingResumeInputMessage(): string {
  return "cannot resume a run with no incomplete tasks without either a follow-up message or a newly added task";
}
