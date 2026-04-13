import { type TaskState, isValidStatus } from "../../assignment/model.js";
import type { ManifestStatus, RunManifest, TaskSnapshot } from "./manifest.js";

export type RunCompletionStatus =
  | "initialized"
  | "success"
  | "blocked"
  | "exhausted"
  | "aborted"
  | "error";

export interface RunCompletionSummary {
  status: RunCompletionStatus;
  attempts: number;
  maxAttempts: number;
  tasksCompleted: number;
  tasksTotal: number;
  assignmentPath: string;
  tasks: TaskState[];
  runId: string;
}

/**
 * A `taskId → {status?, notes?}` overlay parsed live from the workspace
 * `assignment.md` (via `parseAssignment`). Status strings from the file
 * are not yet validated against `TaskStatus` — `applyLiveOverlay` does
 * the validation when constructing the overlaid manifest.
 */
export type LiveTaskOverlay = Map<string, { status?: string; notes?: string }>;

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

/**
 * Build a non-mutating clone of `manifest` with `finalTasks` and
 * `tasksCompleted` overlaid from the live workspace parse. Invalid
 * status strings (anything not in the `TaskStatus` enum) fall back to
 * the manifest's snapshot value for that task. The original manifest
 * is never mutated.
 *
 * Top-level `manifest.status` is **not** changed: a run that has all
 * tasks marked complete on disk is still `running` until the run loop
 * sees that and writes the terminal state itself.
 */
export function applyLiveOverlay(manifest: RunManifest, overlay: LiveTaskOverlay): RunManifest {
  const overlaidTasks: Record<string, TaskSnapshot> = {};
  for (const [id, snap] of Object.entries(manifest.finalTasks)) {
    const live = overlay.get(id);
    const liveStatus =
      live?.status !== undefined && isValidStatus(live.status) ? live.status : snap.status;
    overlaidTasks[id] = {
      ...snap,
      status: liveStatus,
      notes: live?.notes ?? snap.notes,
    };
  }
  const completedCount = Object.values(overlaidTasks).filter(
    (task) => task.status === "completed",
  ).length;
  return {
    ...manifest,
    finalTasks: overlaidTasks,
    tasksCompleted: completedCount,
  };
}
