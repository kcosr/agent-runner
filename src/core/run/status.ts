import type { TaskState, TaskStatus } from "../../assignment/model.js";
import type { RunManifest, TaskSnapshot } from "./manifest.js";

const VALID_TASK_STATUSES: ReadonlySet<TaskStatus> = new Set([
  "pending",
  "in_progress",
  "completed",
  "blocked",
]);

function isTaskStatus(s: string): s is TaskStatus {
  return VALID_TASK_STATUSES.has(s as TaskStatus);
}

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
      live?.status !== undefined && isTaskStatus(live.status) ? live.status : snap.status;
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
