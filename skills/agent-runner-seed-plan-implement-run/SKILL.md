---
name: agent-runner-seed-plan-implement-run
description: Initialize an agent-runner `plan-implement-feature` run from the target repository root. Use this when the user wants to prepare the single-run plan-plus-implement workflow, not when they want the run driven to completion immediately.
---

# Seed Plan-Implement-Feature Run

Use this skill to seed a `plan-implement-feature` run from the target
repository root.

By default, do **not** force `--backend passive`. This workflow is meant
to plan, pause for caller approval, then implement in the same run. Only
use a passive backend if the user explicitly asks for a passive handoff
and understands that you will have to drive the run manually.

This skill stops after initialization. It does **not** drive the planning
stage, approve the plan, implement code changes, run the internal code
review, open or merge a PR, or create/remove a worktree.

## Scope

Do this:

1. Confirm the target repository.
2. Confirm or derive a short task slug.
3. Summarize the agreed feature/design work clearly enough to seed the
   single-run workflow.
4. Write the handoff prompt to a temporary file.
5. Initialize a `plan-implement-feature` run from the repository root
   using `--message-file`.
6. Return the repo root and run id.

Do **not** do this as part of this skill:

- drive the run's planning stage
- approve the generated plan
- implement code changes
- launch the internal `code-review` run
- open or merge a PR
- create or remove a worktree
- create or attach `assignment-seed.md`

## Required Inputs

Before running commands, make sure you know:

- repository root (for example `/path/to/repo`)
- task slug (for example `plan-implement-feature-summary`)
- short run title (2-4 words when possible)
- concise feature/design summary to pass as the run message
- handoff prompt file path in a temporary directory

If the user has not provided a slug, derive one from the task
title/feature and confirm it when needed.

## Handoff Prompt Files

The handoff prompt is the run's initial message file. Its contents are
frozen into the run at init time, so the file itself is throwaway —
create it in a temporary directory:

```text
/tmp/agent-runner-planner-seeds/<task-slug>.md
```

Use one markdown file per feature, named with the git-safe task slug.
Pass the handoff file with `--message-file`; do not pass the handoff
body as positional text. This local message file is only the run's
initial user message. It is not `assignment-seed.md`, and this skill
does not attach it to the run.

## Recommended Flow

### 1. Preflight from repo root

```bash
cd /path/to/<repo-name>
git status --porcelain
```

- If the repo root is dirty, stop and ask the user what to do before
  initializing the run.

### 2. Initialize the single-run workflow from the repo root

```bash
mkdir -p /tmp/agent-runner-planner-seeds

agent-runner init \
  --agent generic \
  --assignment plan-implement-feature \
  --name "<short-descriptive-name>" \
  --message-file /tmp/agent-runner-planner-seeds/<task-slug>.md
```

Use the actual agreed summary as the contents of the handoff file.

If you are running through the local workspace script instead of a
globally installed binary, use the repo's preferred equivalent, for
example:

```bash
npm run agent-runner -- init \
  --agent generic \
  --assignment plan-implement-feature \
  --name "<short-descriptive-name>" \
  --message-file /tmp/agent-runner-planner-seeds/<task-slug>.md
```

Do not pass `--var worktree_slug`; `plan-implement-feature` does not use
the separate implementer-worktree variables from `plan-feature`.

Only if the user explicitly asks for a passive handoff / passive
single-run workflow, use:

```bash
agent-runner init \
  --agent generic \
  --backend passive \
  --assignment plan-implement-feature \
  --name "<short-descriptive-name>" \
  --message-file /tmp/agent-runner-planner-seeds/<task-slug>.md
```

## Output

After init succeeds, report:

- repository root
- run id
- handoff prompt path
- exact brief command for the new run

Example:

- Repo root: `/path/to/repo`
- Run id: `<run-id>`
- Handoff: `/tmp/agent-runner-planner-seeds/<task-slug>.md`
- Brief: `agent-runner run brief <run-id>`

## Guidance

- Keep the summary concise but concrete.
- Prefer a short explicit `--name` rather than reusing a long feature
  description.
- Stop immediately after the run is initialized unless the user
  explicitly asks for the next step.
- Treat this skill as bootstrap/orchestration only; the
  `plan-implement-feature` assignment remains the source of truth for
  the single-run planning and implementation workflow.
- The run itself will produce and attach `assignment-summary.md`, pause
  for caller approval, implement after approval, run the internal
  `code-review` assignment, and gate merge/finalization on explicit
  caller approval.
