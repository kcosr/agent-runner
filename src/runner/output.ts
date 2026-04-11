import type { TaskState, TaskStatus } from "../assignment/model.js";
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

export type RunStatus = "initialized" | "success" | "blocked" | "exhausted" | "aborted" | "error";

export interface RunSummary {
  status: RunStatus;
  attempts: number;
  maxAttempts: number;
  tasksCompleted: number;
  tasksTotal: number;
  assignmentPath: string;
  tasks: TaskState[];
  runId: string;
}

export function renderSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("── summary ──");
  lines.push(`Status: ${summary.status}`);

  if (summary.status === "initialized") {
    lines.push(`Tasks seeded: ${summary.tasksTotal}`);
    lines.push(`Assignment file: ${summary.assignmentPath}`);
    if (summary.tasks.length > 0) {
      lines.push("");
      lines.push("Seeded tasks:");
      for (const task of summary.tasks) {
        lines.push(`  - ${task.id} — ${task.title}`);
      }
    }
    lines.push("");
    lines.push("To execute this run:");
    lines.push(`  task-runner run --resume-run ${summary.runId}`);
    return `${lines.join("\n")}\n`;
  }

  if (summary.status === "aborted") {
    lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
    lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);
    lines.push(`Assignment file: ${summary.assignmentPath}`);
    lines.push("");
    lines.push("Run was interrupted by the user. To resume:");
    lines.push(`  task-runner run --resume-run ${summary.runId} "..."`);
    return `${lines.join("\n")}\n`;
  }

  lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
  lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);
  lines.push(`Assignment file: ${summary.assignmentPath}`);

  if (summary.tasks.length > 0) {
    lines.push("");
    lines.push("Task results:");
    for (const task of summary.tasks) {
      lines.push(`  - ${task.id} — ${task.title} [${task.status}]`);
      const notes = task.notes.trim();
      if (notes) {
        for (const noteLine of notes.split("\n")) {
          lines.push(`      ${noteLine}`);
        }
      }
    }
    lines.push("");
    lines.push(`Review ${summary.assignmentPath} for additional agent output.`);
  }

  lines.push("");
  lines.push("To continue this run with a follow-up message:");
  lines.push(`  task-runner run --resume-run ${summary.runId} "..."`);

  return `${lines.join("\n")}\n`;
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
    (t) => t.status === "completed",
  ).length;
  return {
    ...manifest,
    finalTasks: overlaidTasks,
    tasksCompleted: completedCount,
  };
}

export function renderManifestStatus(
  manifest: RunManifest,
  opts: { isLive?: boolean } = {},
): string {
  const lines: string[] = [];
  lines.push("");
  lines.push(`── run ${manifest.runId} ──`);
  lines.push(
    `Status: ${manifest.status}${manifest.exitCode !== null ? ` (exit ${manifest.exitCode})` : ""}`,
  );
  lines.push(`Agent: ${manifest.agent.name}`);
  if (manifest.assignment) {
    lines.push(`Assignment: ${manifest.assignment.name}`);
  }
  lines.push(`Backend: ${manifest.backend}${manifest.model ? ` (${manifest.model})` : ""}`);
  if (manifest.sessionName) {
    lines.push(`Session name: ${manifest.sessionName}`);
  }
  if (manifest.backendSessionId) {
    lines.push(`Backend session: ${manifest.backendSessionId}`);
  }
  lines.push(`Cwd: ${manifest.cwd}`);
  lines.push(`Workspace: ${manifest.workspaceDir}`);
  lines.push(`Assignment file: ${manifest.assignmentPath}`);
  lines.push(`Started: ${manifest.startedAt}`);
  if (manifest.endedAt) {
    lines.push(`Ended: ${manifest.endedAt}`);
  }
  lines.push(
    `Tasks completed: ${manifest.tasksCompleted}/${manifest.tasksTotal}    Attempts: ${manifest.attempts}/${manifest.maxAttempts}    Sessions: ${manifest.sessionCount}`,
  );

  const taskEntries = Object.values(manifest.finalTasks);
  if (taskEntries.length > 0) {
    lines.push("");
    lines.push("Tasks:");
    for (const task of taskEntries) {
      lines.push(`  - ${task.id} — ${task.title} [${task.status}]`);
      const notes = task.notes.trim();
      if (notes) {
        for (const noteLine of notes.split("\n")) {
          lines.push(`      ${noteLine}`);
        }
      }
    }
  }

  if (manifest.status === "running") {
    lines.push("");
    if (opts.isLive) {
      lines.push(
        "(task statuses above are read live from the workspace assignment.md; the current attempt may still be in progress)",
      );
    } else {
      lines.push("(run is still in progress; status reflects the most recent persisted attempt)");
    }
  } else if (manifest.status === "initialized") {
    lines.push("");
    lines.push("To execute this run:");
    lines.push(`  task-runner run --resume-run ${manifest.runId}`);
  } else if (
    manifest.status === "blocked" ||
    manifest.status === "exhausted" ||
    manifest.status === "aborted" ||
    manifest.status === "error"
  ) {
    lines.push("");
    lines.push("To resume this run:");
    lines.push(`  task-runner run --resume-run ${manifest.runId} "..."`);
  }

  return `${lines.join("\n")}\n`;
}
