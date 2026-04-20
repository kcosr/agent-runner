import { execFileSync } from "node:child_process";
import { defineHook } from "../../hooks.js";
import type { PrepareHookContext } from "./types.js";

interface GitSyncBaseConfig {
  repo: string;
  baseRef: string;
}

function gitEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      return !key.startsWith("GIT_");
    }),
  );
}

function gitSyncBaseConfig(config: unknown): GitSyncBaseConfig {
  if (!config || typeof config !== "object") {
    throw new Error("git-sync-base hook requires an object config");
  }
  const record = config as Record<string, unknown>;
  const repo = record.repo;
  const baseRef = record.baseRef;
  if (typeof repo !== "string" || typeof baseRef !== "string") {
    throw new Error("git-sync-base hook requires `repo` and `baseRef`");
  }
  return { repo, baseRef };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureCleanWorktree(repo: string): void {
  const status = git(["status", "--porcelain", "--untracked-files=all"], repo);
  if (status.length > 0) {
    throw new Error(`git-sync-base requires a clean worktree at ${repo}`);
  }
}

function ensureCurrentBranch(repo: string): void {
  try {
    git(["symbolic-ref", "--quiet", "--short", "HEAD"], repo);
  } catch {
    throw new Error("git-sync-base requires the repo to be on a branch");
  }
}

function syncCurrentBranch(config: GitSyncBaseConfig): void {
  ensureCleanWorktree(config.repo);
  ensureCurrentBranch(config.repo);
  execFileSync("git", ["-C", config.repo, "rebase", config.baseRef], {
    env: gitEnv(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export default defineHook({
  name: "git-sync-base",
  prepare(ctx: PrepareHookContext) {
    const config = gitSyncBaseConfig(ctx.config);
    syncCurrentBranch(config);
    return {
      action: "continue",
    };
  },
});
