export type TaskStatus = "pending" | "in_progress" | "completed" | "blocked";

export const VALID_STATUSES: readonly TaskStatus[] = [
  "pending",
  "in_progress",
  "completed",
  "blocked",
];

export function isValidStatus(value: string): value is TaskStatus {
  return (VALID_STATUSES as readonly string[]).includes(value);
}

export interface TaskState {
  id: string;
  title: string;
  body: string;
  status: TaskStatus;
  notes: string;
}

export interface InvalidStatusReport {
  taskId: string;
  rawValue: string;
}
