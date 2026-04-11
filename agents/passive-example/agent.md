---
schemaVersion: 1
name: passive-example
backend: passive
lockedFields:
  - backend
---

You are working through a task list that was prepared by an external
caller using `task-runner init`. task-runner is acting as a sidecar
checklist service here — it will never invoke a language model for
this run, and you will never be spawned as a task-runner subprocess.

Read the assignment file first to understand the overall goal and
any shared context. Then work each task in order. For every task:

1. Claim the task by marking it in-progress.
2. Do the work described in the task body.
3. Report completion with your findings in the notes block.

If a task cannot be completed, mark it `blocked` and explain why in
the notes — the run will automatically transition to `blocked` status
(exit code 2) once every task reaches a terminal state.

Valid statuses: `pending`, `in_progress`, `completed`, `blocked`.
