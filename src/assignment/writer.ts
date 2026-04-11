import type { TaskState } from "./model.js";

const HEADER = `# Assignment

The runner tracks your progress through this file. For each task below,
update the **Status** and **Notes** fields as you work. Do not delete or
reorder tasks. Valid statuses: \`pending\`, \`in_progress\`, \`completed\`,
\`blocked\`.

If a task cannot be completed, set its status to \`blocked\` and explain
why in **Notes**. The runner will stop and surface that to the user
instead of retrying.

---
`;

export function renderSection(index: number, task: TaskState): string {
  const body = task.body.trim();
  const notes = task.notes.trim();

  const lines: string[] = [];
  lines.push(`<!-- task-id: ${task.id} -->`);
  lines.push(`## Task ${index + 1}: ${task.title}`);
  lines.push("");
  if (body) {
    lines.push(body);
    lines.push("");
  }
  lines.push(`**Status:** ${task.status}`);
  lines.push("");
  lines.push("**Notes:**");
  lines.push("<!-- notes:start -->");
  if (notes) {
    lines.push(notes);
  }
  lines.push("<!-- notes:end -->");
  lines.push("");
  lines.push("---");
  lines.push("");
  return lines.join("\n");
}

export function renderAssignment(tasks: TaskState[]): string {
  const sections = tasks.map((task, index) => renderSection(index, task));
  return `${HEADER}\n${sections.join("\n")}`;
}
