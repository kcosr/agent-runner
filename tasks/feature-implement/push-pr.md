---
schemaVersion: 1
id: feature-implement/push-pr
title: Push the branch and create the PR
---
**Category**: process

Finalize the published git state for this plan. Everything
this run produced must be committed, pushed, and attached
to a PR before the run can end successfully.

  1. Run `git status` and paste the output into Notes.
  2. If review fixes, docs updates, or final verification
     work changed files after `commit`, stage them
     explicitly by file path (not `git add -A` — that can
     pick up files you didn't intend, including
     runtime-state artifacts under the configured
     agent-runner state dir) and create a final focused
     follow-up commit. Follow the repo's commit-message
     convention from `feature-plan/orient`.
  3. If the repo uses pre-commit hooks, let them run. If
     a hook fails, fix the underlying issue and create a
     **new** commit — do not amend past a hook failure,
     and do not use `--no-verify`.
  4. If no post-review changes were needed and the tree is
     already clean, say that plainly in Notes instead of
     creating an empty commit.
  5. If the `feature-implement/apply-review-fixes` delta passes produced
     multiple commits, that's fine — leave them as
     separate commits; do not squash without the
     caller's instruction.
  6. Run `git status` again. The working tree must be
     clean (nothing staged, nothing unstaged, nothing
     untracked that should have been added). If it isn't,
     go back to step 2.
  7. Run `git log --oneline <base>..HEAD` (where `<base>`
     is the commit this plan was planned against — capture
     it from `scaffold` notes or ask the caller in a
     blocked state if you don't know it) and paste the
     list of commits this plan produced into Notes.
  8. Push the current branch to the appropriate remote and
     branch ref for this repo's workflow. Paste the exact
     push command and result into Notes.
  9. Create or open the PR using the repo's normal tool
     (for example `gh pr create`, a web flow, or an
     equivalent wrapper). Paste the exact command/tool you
     used and the result into Notes.
 10. Record the PR URL and PR number. If an existing PR
     already covered the exact branch instead of creating a
     new one, record that existing PR URL/number and why no
     duplicate PR was opened.

Notes should contain:
  - the current branch name
  - the base/target branch for the PR
  - the final `git status` output (should say clean)
  - the list of commit shas this plan produced
  - the base commit the plan started from, for audit
  - the push command/result, including remote + pushed ref
  - the PR creation command/tool used
  - the PR URL and PR number (or the existing PR and why no
    duplicate was created)

Do not merge the PR in this task; merging and
fast-forwarding main are handled by the following
approval-gated task.

If any step fails and you cannot resolve it — a
pre-commit hook fails for a reason outside the plan's
scope, the push fails, or you cannot create/open the PR —
mark this task `blocked` with the failure details. Do not
mark it `completed` while unpublished work remains local or
the PR evidence is missing; that defeats the point of the
terminal workflow.
