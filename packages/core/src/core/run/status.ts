import type { TaskState } from "../../assignment/model.js";
import type { ManifestStatus, RunManifest } from "./manifest.js";

export type RunCompletionStatus =
  | "initialized"
  | "success"
  | "blocked"
  | "exhausted"
  | "aborted"
  | "error";

export interface RunCompletionSummary {
  status: RunCompletionStatus;
  sessionAttemptCount: number;
  maxAttemptsPerSession: number;
  totalAttemptCount: number;
  totalSessionCount: number;
  tasksCompleted: number;
  tasksTotal: number;
  assignmentPath: string;
  tasks: TaskState[];
  runId: string;
}

export function derivePassiveTerminalStatus(
  tasks: Pick<TaskState, "status">[],
): "initialized" | "success" | "blocked" {
  if (tasks.length === 0) {
    return "initialized";
  }
  if (tasks.every((task) => task.status === "completed")) {
    return "success";
  }
  if (
    tasks.every((task) => task.status === "completed" || task.status === "blocked") &&
    tasks.some((task) => task.status === "blocked")
  ) {
    return "blocked";
  }
  // Passive runs stay lifecycle-initialized until task state reaches a terminal mix.
  return "initialized";
}

export function deriveEffectiveStatus(
  manifest: Pick<RunManifest, "backend" | "status" | "finalTasks">,
): ManifestStatus {
  if (manifest.backend !== "passive") {
    return manifest.status;
  }
  if (
    manifest.status === "aborted" ||
    manifest.status === "error" ||
    manifest.status === "exhausted"
  ) {
    return manifest.status;
  }

  const tasks = Object.values(manifest.finalTasks);
  if (tasks.some((task) => task.status === "in_progress")) {
    return "running";
  }
  const terminalStatus = derivePassiveTerminalStatus(tasks);
  if (terminalStatus !== "initialized") {
    return terminalStatus;
  }
  if (tasks.some((task) => task.status === "completed")) {
    return "running";
  }
  return terminalStatus;
}
