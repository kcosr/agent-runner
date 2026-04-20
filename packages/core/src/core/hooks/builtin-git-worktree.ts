import { execFileSync } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { defineHook } from "../../hooks.js";
import type { PrepareHookContext } from "./types.js";

interface GitWorktreeConfig {
  repo: string;
  from: string;
  branch: string;
  path: string;
  collision?: "fail" | "reuse" | "replace";
}

function gitWorktreeConfig(config: unknown): GitWorktreeConfig {
  if (!config || typeof config !== "object") {
    throw new Error("git-worktree hook requires an object config");
  }
  const record = config as Record<string, unknown>;
  const repo = record.repo;
  const from = record.from;
  const branch = record.branch;
  const path = record.path;
  if (
    typeof repo !== "string" ||
    typeof from !== "string" ||
    typeof branch !== "string" ||
    typeof path !== "string"
  ) {
    throw new Error("git-worktree hook requires `repo`, `from`, `branch`, and `path`");
  }
  const collision =
    record.collision === "reuse" || record.collision === "replace" ? record.collision : "fail";
  return { repo, from, branch, path, collision };
}

function git(args: string[], cwd: string): string {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function ensureWorktree(config: GitWorktreeConfig): void {
  if (existsSync(config.path)) {
    if (config.collision === "reuse") {
      return;
    }
    if (config.collision === "replace") {
      try {
        execFileSync("git", ["-C", config.repo, "worktree", "remove", "--force", config.path], {
          stdio: "ignore",
        });
      } catch {
        rmSync(config.path, { recursive: true, force: true });
      }
    } else {
      throw new Error(`git-worktree path ${config.path} already exists`);
    }
  }

  let branchExists = true;
  try {
    git(["rev-parse", "--verify", config.branch], config.repo);
  } catch {
    branchExists = false;
  }

  if (branchExists) {
    execFileSync("git", ["-C", config.repo, "worktree", "add", config.path, config.branch], {
      stdio: "ignore",
    });
    return;
  }

  execFileSync(
    "git",
    ["-C", config.repo, "worktree", "add", "-b", config.branch, config.path, config.from],
    {
      stdio: "ignore",
    },
  );
}

export default defineHook({
  name: "git-worktree",
  prepare(ctx: PrepareHookContext) {
    const config = gitWorktreeConfig(ctx.config);
    ensureWorktree(config);
    return {
      action: "continue",
      mutate: {
        run: {
          cwd: config.path,
        },
        vars: {
          worktree_path: config.path,
        },
      },
    };
  },
});
