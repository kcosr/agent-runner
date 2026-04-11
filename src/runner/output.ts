import type { TaskState } from "../plan/model.js";

export type RunStatus = "success" | "blocked" | "exhausted" | "error";

export interface RunSummary {
  status: RunStatus;
  attempts: number;
  maxAttempts: number;
  tasksCompleted: number;
  tasksTotal: number;
  planPath: string;
  tasks: TaskState[];
}

export function renderSummary(summary: RunSummary): string {
  const lines: string[] = [];
  lines.push("");
  lines.push("── summary ──");
  lines.push(`Status: ${summary.status}`);
  lines.push(`Tasks completed: ${summary.tasksCompleted}/${summary.tasksTotal}`);
  lines.push(`Attempts: ${summary.attempts}/${summary.maxAttempts}`);
  lines.push(`Plan file: ${summary.planPath}`);

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
  }

  lines.push("");
  lines.push(`Review ${summary.planPath} for additional agent output.`);

  return `${lines.join("\n")}\n`;
}
