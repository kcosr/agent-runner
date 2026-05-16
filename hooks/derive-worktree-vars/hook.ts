import { basename, dirname, resolve } from "node:path";

// Keep this hook free of agent-runner package imports: users copy bundled
// config into ~/.config/agent-runner before the package is published.
interface PrepareHookContext {
  vars: Record<string, unknown>;
  run: {
    cwd: string;
  };
}

const WORKTREE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKTREE_BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function readWorktreeSlug(ctx: PrepareHookContext): string {
  const slug = ctx.vars.worktree_slug;
  if (typeof slug !== "string" || slug.trim().length === 0) {
    throw new Error("plan-feature requires a non-empty worktree_slug");
  }
  if (!WORKTREE_SLUG_PATTERN.test(slug)) {
    throw new Error(
      "worktree_slug must match [A-Za-z0-9][A-Za-z0-9._-]* so the derived sibling worktree path is stable",
    );
  }
  return slug;
}

function assertWorktreeBaseRef(ctx: PrepareHookContext): void {
  const baseRef = ctx.vars.worktree_base_ref;
  if (typeof baseRef !== "string" || !WORKTREE_BASE_REF_PATTERN.test(baseRef)) {
    throw new Error(
      "worktree_base_ref must match [A-Za-z0-9][A-Za-z0-9._/-]* so it is safe to use in generated git commands",
    );
  }
}

export default {
  name: "derive-worktree-vars",
  prepare(ctx: PrepareHookContext) {
    const worktreeSlug = readWorktreeSlug(ctx);
    assertWorktreeBaseRef(ctx);
    const repoRoot = ctx.run.cwd;
    const repoName = basename(repoRoot);
    const worktreePath = resolve(dirname(repoRoot), `${repoName}-${worktreeSlug}`);
    return {
      action: "continue",
      mutate: {
        vars: {
          repo_root: repoRoot,
          worktree_path: worktreePath,
        },
      },
    };
  },
};
