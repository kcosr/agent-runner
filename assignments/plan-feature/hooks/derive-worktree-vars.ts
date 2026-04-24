import { basename, dirname, resolve } from "node:path";
import { type PrepareHookContext, defineHook } from "../../../packages/core/src/hooks.ts";

const WORKTREE_SLUG_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const WORKTREE_BASE_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;
const DEFAULT_WORKTREE_BASE_REF = "origin/main";

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

function readWorktreeBaseRef(ctx: PrepareHookContext): {
  needsDefault: boolean;
  value: string;
} {
  const baseRef = ctx.vars.worktree_base_ref;
  if (typeof baseRef !== "string") {
    return { needsDefault: true, value: DEFAULT_WORKTREE_BASE_REF };
  }
  if (!WORKTREE_BASE_REF_PATTERN.test(baseRef)) {
    throw new Error(
      "worktree_base_ref must match [A-Za-z0-9][A-Za-z0-9._/-]* so it is safe to interpolate into git commands",
    );
  }
  return { needsDefault: false, value: baseRef };
}

export default defineHook({
  name: "derive-worktree-vars",
  prepare(ctx: PrepareHookContext) {
    const worktreeSlug = readWorktreeSlug(ctx);
    const worktreeBaseRef = readWorktreeBaseRef(ctx);
    const repoRoot = ctx.run.cwd;
    const repoName = basename(repoRoot);
    const worktreePath = resolve(dirname(repoRoot), `${repoName}-${worktreeSlug}`);
    return {
      action: "continue",
      mutate: {
        vars: {
          repo_root: repoRoot,
          worktree_path: worktreePath,
          ...(worktreeBaseRef.needsDefault ? { worktree_base_ref: worktreeBaseRef.value } : {}),
        },
      },
    };
  },
});
