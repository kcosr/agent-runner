---
schemaVersion: 1
id: feature-implement/commit
title: Commit review candidate before internal review
---
**Category**: process

Create a clean reviewable commit before launching the nested
review.

  1. Run `git status` and paste the output into Notes.
  2. Stage only the files changed so far for this plan,
     including rebuilt `dist/` output if any `src/` file
     changed.
  3. Commit with a clear focused message describing the
     work from this plan. Follow the repo's commit-message
     convention from `feature-plan/orient`.
  4. If the repo uses pre-commit hooks, let them run. If
     a hook fails, fix the underlying issue and create a
     new commit — do not amend past a hook failure, and
     do not use `--no-verify`.
  5. Run `git status` again and confirm the tree is clean.
  6. Run `git log --oneline <base>..HEAD` and paste the
     commits into Notes.

`feature-implement/internal-code-review` should use the same `<base>..HEAD` range
when launching the nested code review. If hooks fail or the
tree is not clean, fix that here before moving on.
