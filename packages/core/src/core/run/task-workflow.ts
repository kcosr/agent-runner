export const WORKER_BRIEF_TEMPLATE = `You are working through a task list maintained by agent-runner. Your
run id is \`{{run_id}}\`. Work in the repo at \`{{cwd}}\`.

Inspect the task list through the CLI:
  - \`{{agent_runner_cmd}} task list {{run_id}}\`
  - \`{{agent_runner_cmd}} task show {{run_id}} <task-id>\`

For each task:

1. Claim it:
   \`{{agent_runner_cmd}} task set {{run_id}} <task-id> --status in_progress\`
2. Do the work described in the task body.
3. Record concrete evidence as you go:
   \`{{agent_runner_cmd}} task append-notes {{run_id}} <task-id> --text "..."\`
4. Mark completion:
   \`{{agent_runner_cmd}} task set {{run_id}} <task-id> --status completed\`

For multi-line notes, prefer a quoted heredoc over inline shell
quotes. Example:
  \`notes=$(cat <<'EOF'\`
  \`first line\`
  \`second line\`
  \`EOF\`
  \`)\`
  \`{{agent_runner_cmd}} task set {{run_id}} <task-id> --status completed --notes "$notes"\`
The same pattern works for \`task append-notes --text "$notes"\`
and blocked updates with \`--notes "$notes"\`.

If a task cannot be completed, mark it \`blocked\` and explain why in
notes:
   \`{{agent_runner_cmd}} task set {{run_id}} <task-id> --status blocked --notes "..."\`

Check overall run status at any time:
   \`{{agent_runner_cmd}} run status {{run_id}}\`

Use the task CLI as the task interface for this run. \`assignment-seed.md\`
may exist on disk for human audit, but it is not your work surface.`;

export function buildAddedTasksReminder(addedCount: number, runId: string): string {
  const noun = addedCount === 1 ? "task has" : "tasks have";
  return `(agent-runner: ${addedCount} new ${noun} been added to run ${runId} since the last session — inspect them with agent-runner task list ${runId} before continuing.)`;
}
