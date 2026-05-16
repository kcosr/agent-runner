---
name: agent-runner-seed-plan-run
description: Initialize an agent-runner `plan-feature` run from the target repository root. Use this when the user wants to prepare planning, not when they want the planning run driven to completion.
---

# Seed Plan-Feature Run

Use this skill to seed a `plan-feature` run from the target repository root.

By default, do **not** force `--backend passive`.
Only use a passive planning run if the user explicitly asks for a passive handoff or passive planning run.

This skill stops after initialization. It does **not** drive the planning run, implement the feature, open a PR, merge anything, or create the later implementer worktree.

## Scope

Do this:

1. Confirm the target repository.
2. Confirm or derive a short task slug.
3. Summarize the agreed feature/design work clearly enough to seed planning.
4. Write the handoff prompt to a temporary file.
5. Initialize a `plan-feature` run from the repository root using `--message-file`.
6. Return the repo root and run id.

Do **not** do this as part of this skill:

- drive the planning run to completion
- create the implementer run
- implement code changes
- open or merge a PR
- create or remove a worktree

## Required Inputs

Before running commands, make sure you know:

- repository root (for example `/path/to/repo`)
- task slug (for example `cli-status-planning-cleanup`)
- short run title (2-4 words when possible)
- concise feature/design summary to pass as the run message
- handoff prompt file path in a temporary directory

If the user has not provided a slug, derive one from the task title/feature and confirm it when needed.

## Handoff Prompt Files

The handoff prompt is the run's initial message file. Its contents are frozen into the run at init time, so the file itself is throwaway — create it in a temporary directory:

```text
/tmp/agent-runner-planner-seeds/<task-slug>.md
```

Use one markdown file per planned feature, named with the git-safe task slug. Pass the handoff file with `--message-file`; do not pass the handoff body as positional text.

## Recommended Flow

### 1. Preflight from repo root

```bash
cd /path/to/<repo-name>
git status --porcelain
```

- If the repo root is dirty, stop and ask the user what to do before initializing the planning run.

### 2. Initialize the planning run from the repo root

```bash
mkdir -p /tmp/agent-runner-planner-seeds

agent-runner init \
  --agent planner \
  --assignment plan-feature \
  --var worktree_slug=<git-safe-slug> \
  --name "<short-descriptive-name>" \
  --message-file /tmp/agent-runner-planner-seeds/<task-slug>.md
```

Use the actual agreed summary as the contents of the handoff file.

If you are running through the local workspace script instead of a globally installed binary, use the repo's preferred equivalent, for example:

```bash
npm run agent-runner -- init \
  --agent planner \
  --assignment plan-feature \
  --var worktree_slug=<git-safe-slug> \
  --name "<short-descriptive-name>" \
  --message-file /tmp/agent-runner-planner-seeds/<task-slug>.md
```

Only if the user explicitly asks for a passive handoff / passive planning run, use:

```bash
agent-runner init \
  --agent planner \
  --backend passive \
  --assignment plan-feature \
  --var worktree_slug=<git-safe-slug> \
  --name "<short-descriptive-name>" \
  --message-file /tmp/agent-runner-planner-seeds/<task-slug>.md
```

The `worktree_slug` var is required. Pass a git-safe slug because the planner freezes it into later descendant implementer/reviewer worktree vars.

Do **not** create the implementer worktree during this skill. The current system creates or reuses that worktree later during the implementation flow.

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
- Prefer a short explicit `--name` rather than reusing a long feature description.
- Stop immediately after the run is initialized unless the user explicitly asks for the next planning step.
- Treat this skill as bootstrap/orchestration only; the `plan-feature` assignment remains the source of truth for the planning workflow itself.
