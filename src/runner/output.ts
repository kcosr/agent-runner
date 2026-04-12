import type { TaskState, TaskStatus } from "../assignment/model.js";
import type { RunDetail } from "../contracts/runs.js";
import { resolveTaskRunnerCommand } from "../task-runner-command.js";
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
  const taskRunnerCmd = resolveTaskRunnerCommand();
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
    lines.push(`  ${taskRunnerCmd} run --resume-run ${summary.runId}`);
    return `${lines.join("\n")}\n`;
  }

  if (summary.status === "aborted") {
    lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
    lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);
    lines.push(`Assignment file: ${summary.assignmentPath}`);
    lines.push("");
    lines.push("Run was interrupted by the user. To resume:");
    lines.push(`  ${taskRunnerCmd} run --resume-run ${summary.runId} "..."`);
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
  lines.push(`  ${taskRunnerCmd} run --resume-run ${summary.runId} "..."`);

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

export function renderRunStatus(detail: RunDetail): string {
  const taskRunnerCmd = resolveTaskRunnerCommand();
  const lines: string[] = [];
  lines.push("");
  lines.push(`── run ${detail.runId} ──`);
  lines.push(
    `Status: ${detail.status}${detail.exitCode !== null ? ` (exit ${detail.exitCode})` : ""}`,
  );
  lines.push(`Agent: ${detail.agent.name}`);
  if (detail.assignment) {
    lines.push(`Assignment: ${detail.assignment.name}`);
  }
  lines.push(`Backend: ${detail.backend}${detail.model ? ` (${detail.model})` : ""}`);
  if (detail.sessionName) {
    lines.push(`Session name: ${detail.sessionName}`);
  }
  if (detail.backendSessionId) {
    lines.push(`Backend session: ${detail.backendSessionId}`);
  }
  lines.push(`Cwd: ${detail.cwd}`);
  lines.push(`Workspace: ${detail.workspaceDir}`);
  lines.push(`Assignment file: ${detail.assignmentPath}`);
  lines.push(`Started: ${detail.startedAt}`);
  if (detail.endedAt) {
    lines.push(`Ended: ${detail.endedAt}`);
  }
  if (detail.archivedAt) {
    lines.push(`Archived: ${detail.archivedAt}`);
  }
  // Passive runs never run backend attempts or create sessions, so
  // the Attempts / Sessions fields are always `0/0` / `0` and add
  // noise. Hide them for passive.
  if (detail.backend === "passive") {
    lines.push(`Tasks completed: ${detail.tasksCompleted}/${detail.tasksTotal}`);
  } else {
    lines.push(
      `Tasks completed: ${detail.tasksCompleted}/${detail.tasksTotal}    Attempts: ${detail.attempts}/${detail.maxAttempts}    Sessions: ${detail.sessionCount}`,
    );
  }

  if (detail.tasks.length > 0) {
    lines.push("");
    lines.push("Tasks:");
    for (const task of detail.tasks) {
      lines.push(`  - ${task.id} — ${task.title} [${task.status}]`);
      const notes = task.notes.trim();
      if (notes) {
        for (const noteLine of notes.split("\n")) {
          lines.push(`      ${noteLine}`);
        }
      }
    }
  }

  const isPassive = detail.backend === "passive";
  const isArchived = detail.archivedAt !== null;

  if (detail.status === "running") {
    lines.push("");
    if (detail.taskMode === "cli") {
      lines.push(
        "(task statuses above come from canonical run.json task state; assignment.md is rendered for audit only)",
      );
    } else if (detail.isLive) {
      lines.push(
        "(task statuses above are read live from the workspace assignment.md; the current attempt may still be in progress)",
      );
    } else {
      lines.push("(run is still in progress; status reflects the most recent persisted attempt)");
    }
  } else if (isArchived) {
    lines.push("");
    lines.push("Run is archived. Unarchive it before resuming:");
    lines.push(`  ${taskRunnerCmd} run unarchive ${detail.runId}`);
  } else if (detail.status === "initialized") {
    lines.push("");
    if (isPassive) {
      lines.push("Drive this run externally:");
      lines.push(`  ${taskRunnerCmd} task set ${detail.runId} <task-id> --status in_progress`);
      lines.push(
        `  ${taskRunnerCmd} task set ${detail.runId} <task-id> --status completed --notes "..."`,
      );
      lines.push('  For multi-line notes, prefer a quoted heredoc and pass --notes "$notes".');
    } else {
      lines.push("To execute this run:");
      lines.push(`  ${taskRunnerCmd} run --resume-run ${detail.runId}`);
    }
  } else if (
    detail.status === "blocked" ||
    detail.status === "exhausted" ||
    detail.status === "aborted" ||
    detail.status === "error"
  ) {
    lines.push("");
    if (isPassive) {
      lines.push("Reopen tasks to continue:");
      lines.push(`  ${taskRunnerCmd} task set ${detail.runId} <task-id> --status in_progress`);
    } else {
      lines.push("To resume this run:");
      lines.push(`  ${taskRunnerCmd} run --resume-run ${detail.runId} "..."`);
    }
  }

  return `${lines.join("\n")}\n`;
}
