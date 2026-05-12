---
schemaVersion: 1
id: feature-implement/scaffold
title: Branch, scaffold, and workspace setup
---
**Category**: hybrid

Read the planning Notes and attached `assignment-summary.md`. Confirm the target repo, base branch, current branch, and working tree state before editing.

Create or switch to the feature branch the caller approved. If the repo root is dirty with unrelated changes, work with them only when they are part of this plan; otherwise block with the exact paths that prevent safe implementation.

Completion Notes must include:
  - current branch name
  - base commit sha
  - `git status --short --branch` output
  - whether a new branch was created or an existing branch was reused
  - any workspace setup commands and exit codes
