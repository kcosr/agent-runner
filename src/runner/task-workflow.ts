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

// Passive variant: the agent works the checklist through task-runner
// CLI calls instead of editing {{assignment_path}} directly. Used when
// the agent's backend is `passive` and task-runner is acting as a
// sidecar checklist service rather than an LLM invoker.
export const PASSIVE_TASK_WORKFLOW_TEMPLATE = `You are working through a task list maintained by task-runner. Your
run id is \`{{run_id}}\`. The task list lives at \`{{assignment_path}}\`
and is the source of truth for what's left to do.

For each task in the list:

1. Claim it:
   \`{{task_runner_cmd}} task set {{run_id}} <task-id> --status in_progress\`
2. Do the work described in the task body.
3. Report completion with your findings:
   \`{{task_runner_cmd}} task set {{run_id}} <task-id> --status completed --notes "..."\`

If a task cannot be completed, mark it \`blocked\` instead and explain
why in the notes — the run auto-finalizes to \`blocked\` status and
exit code 2:
   \`{{task_runner_cmd}} task set {{run_id}} <task-id> --status blocked --notes "..."\`

Check remaining work at any time:
   \`{{task_runner_cmd}} status {{run_id}}\`

To re-fetch these instructions later:
   \`{{task_runner_cmd}} status {{run_id}} --output-format json --field pendingPrompt\`

When every task reaches a terminal status (\`completed\` / \`blocked\`),
the run automatically transitions to \`success\` (if all completed) or
\`blocked\` (if any blocked).`;

export function buildAddedTasksReminder(addedCount: number, assignmentPath: string): string {
  const noun = addedCount === 1 ? "task has" : "tasks have";
  return `(task-runner: ${addedCount} new ${noun} been added to your assignment since the last session — please re-read ${assignmentPath} before continuing.)`;
}
