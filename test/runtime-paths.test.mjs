import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  UNKNOWN_REPO_KEY,
  deriveRepoKey,
  isPathArg,
  resolveTaskRunnerStateDir,
  slugifyRepoKey,
} from "../dist/config/runtime-paths.js";

test("slugifyRepoKey normalizes separators, leading slashes, and case", () => {
  assert.equal(slugifyRepoKey("/Users/KeVin/worktrees/Repo"), "users-kevin-worktrees-repo");
  assert.equal(slugifyRepoKey("feature\\Nested/Repo"), "feature-nested-repo");
  assert.equal(slugifyRepoKey(""), UNKNOWN_REPO_KEY);
});

test("isPathArg recognizes slash-bearing args and dot-slash relative paths only", () => {
  assert.equal(isPathArg("code-review"), false);
  assert.equal(isPathArg("./assignments/code-review/assignment.md"), true);
  assert.equal(isPathArg("../assignments/code-review/assignment.md"), true);
  assert.equal(isPathArg("assignments/code-review/assignment.md"), true);
  assert.equal(isPathArg(".\\assignments\\code-review\\assignment.md"), false);
});

test("deriveRepoKey falls back to unknown outside git", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-runner-runtime-paths-"));
  assert.equal(deriveRepoKey(dir), UNKNOWN_REPO_KEY);
});

test("deriveRepoKey ignores inherited git hook environment when probing outside git", () => {
  const dir = mkdtempSync(join(tmpdir(), "task-runner-runtime-paths-hook-"));
  const originalGitDir = process.env.GIT_DIR;
  const originalGitWorkTree = process.env.GIT_WORK_TREE;

  process.env.GIT_DIR = execFileSync("git", ["rev-parse", "--absolute-git-dir"], {
    encoding: "utf8",
  }).trim();
  process.env.GIT_WORK_TREE = process.cwd();

  try {
    assert.equal(deriveRepoKey(dir), UNKNOWN_REPO_KEY);
  } finally {
    if (originalGitDir === undefined) {
      process.env.GIT_DIR = undefined;
    } else {
      process.env.GIT_DIR = originalGitDir;
    }
    if (originalGitWorkTree === undefined) {
      process.env.GIT_WORK_TREE = undefined;
    } else {
      process.env.GIT_WORK_TREE = originalGitWorkTree;
    }
  }
});

test("resolveTaskRunnerStateDir uses explicit, xdg, then HOME fallback order", () => {
  assert.equal(
    resolveTaskRunnerStateDir({
      TASK_RUNNER_STATE_DIR: "/explicit/state",
      XDG_STATE_HOME: "/xdg/state",
      HOME: "/home/user",
    }),
    "/explicit/state",
  );
  assert.equal(
    resolveTaskRunnerStateDir({
      XDG_STATE_HOME: "/xdg/state",
      HOME: "/home/user",
    }),
    "/xdg/state/task-runner",
  );
  assert.equal(
    resolveTaskRunnerStateDir({
      HOME: "/home/user",
    }),
    "/home/user/.local/state/task-runner",
  );
});
