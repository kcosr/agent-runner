---
schemaVersion: 1
id: feature-implement/merge-after-approval
title: Merge PR and fast-forward main after caller approval
---
**Category**: process

This task is the post-PR merge and fast-forward gate.
Do **not** merge the PR or fast-forward the main worktree
during the initial implementation session.

On the initial implementation pass, do not perform any
merge or fast-forward work. Immediately mark this task
`blocked` with Notes saying the PR is ready and this task
is waiting for explicit caller approval to merge and
fast-forward.

Include in Notes:
  - PR URL and PR number from `feature-implement/push-pr`
  - current branch name
  - target/base branch
  - final `git status`
  - commits included in the PR
  - any reviewer/caller caveats before merge

Only proceed if the caller later resumes this run and
explicitly approves merge and fast-forward.

Once approved:

  1. Re-check repo state: current branch, `git status`,
     PR status, and target branch.
  2. Confirm the PR is still the one created by this run.
  3. If the repo requires the `CHANGELOG.md` PR link to be
     updated after PR creation and that was not already done,
     update it, commit it to the same branch, and push it.
  4. Merge the PR using the repo's normal merge strategy.
  5. Fast-forward the main worktree to `origin/main`.
  6. Record the merge commit / resulting main commit, final
     `git status`, and fast-forward evidence in Notes.

Follow existing repo conventions for PR text, changelog
formatting, and merge strategy.

For a follow-up commit that only updates `CHANGELOG.md` with
the PR link and touches no source, test, package, generated,
or other documentation files, set `HUSKY=0` on that commit to
skip the expensive pre-commit `npm run check` gate. Do not set
`HUSKY=0` for any other follow-up commit.

Do not mark this task `completed` until the caller has
approved merge/fast-forward and every step above has
succeeded. If approval has not been provided, the correct
status is `blocked`.
