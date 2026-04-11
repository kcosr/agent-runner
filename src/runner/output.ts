import type { TaskState } from "../assignment/model.js";

export type RunStatus = "success" | "blocked" | "exhausted" | "error";

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
