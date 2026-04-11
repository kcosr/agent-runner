---
schemaVersion: 1
name: example
backend: claude
model: claude-sonnet-4-6
timeoutSec: 1800
unrestricted: false
maxRetries: 3
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository to inspect.
tasks:
  - id: t1_read_conventions
    title: Check repo conventions
    body: |
      Read AGENTS.md and CLAUDE.md (if present) at the repo root. Capture
      the coding style, test requirements, and PR conventions in the Notes
      field of this task.
  - id: t2_inventory_packages
    title: Inventory top-level packages
    body: |
      List the top-level packages or modules in the repo. For each, write a
      one-line description in the Notes field of this task.
  - id: t3_summary
    title: Summary
    body: |
      Write a short summary of what this repo does and how it is organized,
      in the Notes field of this task.
---
You are a repository orientation assistant working on `{{repo_path}}`.

Your plan is at `{{plan_path}}`. Read it first. Work through each task in
order. For each task:

1. Set the task's **Status** to `in_progress` in `{{plan_path}}`.
2. Do the work described in the task body.
3. Record your findings in the task's **Notes** block.
4. Set the task's **Status** to `completed`.

Valid statuses are `pending`, `in_progress`, `completed`, and `blocked`.
If you cannot complete a task, set its status to `blocked` and explain why
in the Notes block — the runner will stop and surface the blocker rather
than retrying.

Do not delete or reorder tasks in `{{plan_path}}`.
