import type { TaskState } from "../plan/model.js";

export type RunStatus = "success" | "blocked" | "exhausted" | "error";

export interface RunSummary {
  status: RunStatus;
  attempts: number;
  maxAttempts: number;
  tasksCompleted: number;
  tasksTotal: number;
  planPath: string;
  blockedTasks: TaskState[];
  incompleteTasks: TaskState[];
}

export function renderSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("── summary ──");
  lines.push(`Status: ${summary.status}`);
  lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
  lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);
  lines.push(`Plan file: ${summary.planPath}`);

  if (summary.blockedTasks.length > 0) {
    lines.push("");
    lines.push("Blocked tasks:");
    for (const task of summary.blockedTasks) {
      lines.push(`  - ${task.id} — ${task.title}`);
      const notes = task.notes.trim();
      if (notes) {
        for (const noteLine of notes.split("\n")) {
          lines.push(`      ${noteLine}`);
        }
      }
    }
  }

  if (summary.status === "exhausted" && summary.incompleteTasks.length > 0) {
    lines.push("");
    lines.push("Incomplete tasks:");
    for (const task of summary.incompleteTasks) {
      lines.push(`  - ${task.id} (${task.status}) — ${task.title}`);
    }
  }

  return `${lines.join("\n")}\n`;
}
