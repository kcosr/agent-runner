import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  UNKNOWN_REPO_KEY,
  deriveRepoKey,
  isPathArg,
  resolveAgentRunnerStateDir,
  resolveLaunchersRoot,
  resolveRunsBucketDir,
  slugifyRepoKey,
} from "../packages/core/dist/config/runtime-paths.js";

test("slugifyRepoKey normalizes separators, leading slashes, and case", () => {
  assert.equal(slugifyRepoKey("/Users/KeVin/worktrees/Repo"), "users-kevin-worktrees-repo");
  assert.equal(slugifyRepoKey("feature\\Nested/Repo"), "feature-nested-repo");
  assert.equal(slugifyRepoKey(""), UNKNOWN_REPO_KEY);
});

test("deriveRepoKey uses the repo basename instead of the full parent path", () => {
  const parentDir = mkdtempSync(join(tmpdir(), "agent-runner-runtime-paths-repo-"));
  const repoDir = join(parentDir, "agent-runner");
  mkdirSync(repoDir);
  execFileSync("git", ["init", "--initial-branch=main", repoDir], { encoding: "utf8" });

  assert.equal(deriveRepoKey(repoDir), "agent-runner");
});

test("isPathArg recognizes only explicit path prefixes and absolute paths", () => {
  assert.equal(isPathArg("code-review"), false);
  assert.equal(isPathArg("./assignments/code-review/assignment.md"), true);
  assert.equal(isPathArg("../assignments/code-review/assignment.md"), true);
  assert.equal(isPathArg("assignments/code-review/assignment.md"), false);
  assert.equal(isPathArg(".\\assignments\\code-review\\assignment.md"), false);
});

test("deriveRepoKey falls back to unknown outside git", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-runner-runtime-paths-"));
  assert.equal(deriveRepoKey(dir), UNKNOWN_REPO_KEY);
});

test("deriveRepoKey ignores inherited git hook environment when probing outside git", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-runner-runtime-paths-hook-"));
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

test("resolveAgentRunnerStateDir uses explicit, xdg, then HOME fallback order", () => {
  assert.equal(
    resolveAgentRunnerStateDir({
      AGENT_RUNNER_STATE_DIR: "/explicit/state",
      XDG_STATE_HOME: "/xdg/state",
      HOME: "/home/user",
    }),
    "/explicit/state",
  );
  assert.equal(
    resolveAgentRunnerStateDir({
      XDG_STATE_HOME: "/xdg/state",
      HOME: "/home/user",
    }),
    "/xdg/state/agent-runner",
  );
  assert.equal(
    resolveAgentRunnerStateDir({
      HOME: "/home/user",
    }),
    "/home/user/.local/state/agent-runner",
  );
});

test("resolveRunsBucketDir joins the runs root with an arbitrary bucket name", () => {
  assert.equal(
    resolveRunsBucketDir("agent-runner", {
      AGENT_RUNNER_STATE_DIR: "/tmp/state",
    }),
    "/tmp/state/runs/agent-runner",
  );
});

test("resolveLaunchersRoot places launchers beside agents and assignments in the config dir", () => {
  assert.equal(
    resolveLaunchersRoot({
      AGENT_RUNNER_CONFIG_DIR: "/tmp/config",
    }),
    "/tmp/config/launchers",
  );
});
