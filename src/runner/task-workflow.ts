export const TASK_WORKFLOW_TEMPLATE = `Your assignment is at \`{{assignment_path}}\`. Read it first. Work
through each task in order. For each task:

1. Set the task's **Status** to \`in_progress\`.
2. Do the work described in the task body.
3. Record your findings in the task's **Notes** block.
4. Set the task's **Status** to \`completed\`.

Valid statuses are \`pending\`, \`in_progress\`, \`completed\`, and \`blocked\`.
If you cannot complete a task, set its status to \`blocked\` and explain
why in the Notes block — the runner will stop and surface the blocker
rather than retrying.

Do not delete or reorder tasks in \`{{assignment_path}}\`.`;

export function buildAddedTasksReminder(addedCount: number, assignmentPath: string): string {
  const noun = addedCount === 1 ? "task has" : "tasks have";
  return `(task-runner: ${addedCount} new ${noun} been added to your assignment since the last session — please re-read ${assignmentPath} before continuing.)`;
}
