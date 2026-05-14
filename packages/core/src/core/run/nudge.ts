import {
  type InvalidStatusReport,
  type TaskState,
  VALID_STATUSES,
} from "../../assignment/model.js";

export function buildNudgeMessage(
  tasks: Map<string, TaskState>,
  invalid: InvalidStatusReport[],
  runId: string,
): string {
  const incomplete: TaskState[] = [];
  for (const task of tasks.values()) {
    if (task.status !== "completed") incomplete.push(task);
  }

  const lines: string[] = [];
  lines.push(`Some tasks in run ${runId} are not yet completed. Please continue.`);
  lines.push(`Inspect them with: agent-runner task list ${runId}`);
  lines.push("");
  lines.push("Remaining tasks:");
  for (const task of incomplete) {
    lines.push(`- ${task.id} (status: ${task.status}) — ${task.title}`);
  }

  if (invalid.length > 0) {
    lines.push("");
    lines.push("Invalid status values:");
    for (const entry of invalid) {
      lines.push(
        `- ${entry.taskId} had status "${entry.rawValue}"; use one of the valid statuses instead.`,
      );
    }
  }

  lines.push("");
  lines.push(`Valid statuses: ${VALID_STATUSES.join(", ")}.`);
  lines.push("Update each task's Status to `completed` when done. If you cannot complete");
  lines.push("a task, set its status to `blocked` and explain in Notes — the runner will");
  lines.push("stop and report it instead of retrying.");

  return lines.join("\n");
}
