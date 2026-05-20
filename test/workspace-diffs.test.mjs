import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { getWorkspaceDiff } from "../packages/core/dist/app/service.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { MAX_WORKSPACE_DIFF_BYTES } from "../packages/core/dist/contracts/workspace-diffs.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const AGENT = `---
schemaVersion: 1
name: workspace-diff-agent
backend: passive
---
Workspace diff test agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: workspace-diff-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Workspace diff test assignment.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-workspace-diffs-"));
}

function git(cwd, args, options = {}) {
  return execFileSync("git", args, {
    cwd,
    encoding: options.encoding ?? "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
    stdio: options.stdio ?? ["ignore", "pipe", "pipe"],
  });
}

function writeBundle(baseDir) {
  const agentDir = join(baseDir, "agents", "workspace-diff-agent");
  const assignmentDir = join(baseDir, "assignments", "workspace-diff-work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(assignmentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.md"), AGENT);
  writeFileSync(join(assignmentDir, "assignment.md"), ASSIGNMENT);
}

async function initRun(baseDir) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("workspace-diff-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("workspace-diff-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        parentRunId: null,
        backend: { id: "mock", invoke: async () => ({}) },
        initialize: true,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function initGitRepo(dir) {
  git(dir, ["init", "-b", "main"]);
  git(dir, ["config", "user.email", "agent-runner@example.invalid"]);
  git(dir, ["config", "user.name", "Agent Runner"]);
}

function fileByPath(diff, path) {
  const file = diff.files.find((entry) => entry.path === path);
  assert.ok(file, `expected ${path} in diff files`);
  return file;
}

test("workspace diff service returns branch merge-base and direct comparisons", async () => {
  const dir = tempDir();
  writeBundle(dir);
  initGitRepo(dir);
  writeFileSync(join(dir, "feature.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  git(dir, ["checkout", "-b", "feature"]);
  writeFileSync(join(dir, "feature.txt"), "base\nfeature\n");
  git(dir, ["commit", "-am", "feature"]);
  git(dir, ["checkout", "main"]);
  writeFileSync(join(dir, "main-only.txt"), "main\n");
  git(dir, ["add", "main-only.txt"]);
  git(dir, ["commit", "-m", "main only"]);
  git(dir, ["checkout", "feature"]);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const mergeBase = await getWorkspaceDiff(outcome.workspaceDir, {
      mode: "branch",
      base: "main",
      head: "HEAD",
      comparison: "merge-base",
    });
    assert.equal(mergeBase.mode, "branch");
    assert.equal(mergeBase.displayRange, "main...HEAD");
    assert.equal(mergeBase.baseRef, "main");
    assert.equal(mergeBase.headRef, "HEAD");
    assert.equal(mergeBase.comparison, "merge-base");
    assert.equal(mergeBase.truncated, false);
    assert.equal(fileByPath(mergeBase, "feature.txt").status, "modified");
    assert.equal(
      mergeBase.files.some((file) => file.path === "main-only.txt"),
      false,
    );

    const direct = await getWorkspaceDiff(outcome.workspaceDir, {
      mode: "branch",
      base: "main",
      head: "HEAD",
      comparison: "direct",
    });
    assert.equal(direct.displayRange, "main..HEAD");
    assert.equal(fileByPath(direct, "feature.txt").status, "modified");
    assert.equal(fileByPath(direct, "main-only.txt").status, "deleted");
    assert.match(direct.patch, /diff --git a\/main-only\.txt b\/main-only\.txt/);
  });
});

test("workspace diff service reports clear missing base and head ref errors", async () => {
  const dir = tempDir();
  writeBundle(dir);
  initGitRepo(dir);
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    await assert.rejects(
      () =>
        getWorkspaceDiff(outcome.workspaceDir, {
          mode: "branch",
          base: "missing-base",
          head: "HEAD",
          comparison: "merge-base",
        }),
      /missing git base ref "missing-base"/,
    );
    await assert.rejects(
      () =>
        getWorkspaceDiff(outcome.workspaceDir, {
          mode: "branch",
          base: "main",
          head: "missing-head",
          comparison: "direct",
        }),
      /missing git head ref "missing-head"/,
    );
  });
});

test("workspace diff service sanitizes inherited GIT environment variables", async () => {
  const dir = tempDir();
  writeBundle(dir);
  initGitRepo(dir);
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  writeFileSync(join(dir, "tracked.txt"), "base\nchanged\n");
  const outcome = await initRun(dir);
  const originalGitIndexFile = process.env.GIT_INDEX_FILE;
  process.env.GIT_INDEX_FILE = join(dir, "missing-index");
  try {
    await withSharedRuntimeEnv(dir, async () => {
      const diff = await getWorkspaceDiff(outcome.workspaceDir, { mode: "working-tree" });
      assert.equal(fileByPath(diff, "tracked.txt").status, "modified");
      assert.match(diff.patch, /\+changed/);
    });
  } finally {
    if (originalGitIndexFile === undefined) {
      Reflect.deleteProperty(process.env, "GIT_INDEX_FILE");
    } else {
      process.env.GIT_INDEX_FILE = originalGitIndexFile;
    }
  }
});

test("workspace diff service combines staged, unstaged, deleted, renamed, copied, untracked, and binary working-tree files", async () => {
  const dir = tempDir();
  writeBundle(dir);
  initGitRepo(dir);
  writeFileSync(join(dir, "copy-source.txt"), "copy source\n");
  writeFileSync(join(dir, "delete-me.txt"), "delete\n");
  writeFileSync(join(dir, "modify.txt"), "one\n");
  writeFileSync(join(dir, "rename-me.txt"), "rename\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);

  writeFileSync(join(dir, "modify.txt"), "one\ntwo\n");
  writeFileSync(join(dir, "staged.txt"), "staged\n");
  git(dir, ["add", "staged.txt"]);
  git(dir, ["rm", "delete-me.txt"]);
  git(dir, ["mv", "rename-me.txt", "renamed.txt"]);
  writeFileSync(join(dir, "copy-source-copy.txt"), "copy source\n");
  git(dir, ["add", "copy-source-copy.txt"]);
  writeFileSync(join(dir, "untracked.txt"), "new\nlines\n");
  writeFileSync(join(dir, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const diff = await getWorkspaceDiff(outcome.workspaceDir, { mode: "working-tree" });
    assert.equal(diff.mode, "working-tree");
    assert.equal(diff.displayRange, "Working tree");
    assert.equal(diff.baseRef, null);
    assert.equal(diff.headRef, null);
    assert.equal(diff.comparison, null);
    assert.equal(fileByPath(diff, "modify.txt").status, "modified");
    assert.equal(fileByPath(diff, "staged.txt").status, "added");
    assert.equal(fileByPath(diff, "delete-me.txt").status, "deleted");
    assert.deepEqual(
      {
        status: fileByPath(diff, "renamed.txt").status,
        oldPath: fileByPath(diff, "renamed.txt").oldPath,
      },
      { status: "renamed", oldPath: "rename-me.txt" },
    );
    assert.ok(["added", "copied"].includes(fileByPath(diff, "copy-source-copy.txt").status));
    assert.equal(fileByPath(diff, "untracked.txt").status, "untracked");
    assert.equal(fileByPath(diff, "untracked.txt").additions, 3);
    assert.deepEqual(
      {
        status: fileByPath(diff, "binary.bin").status,
        binary: fileByPath(diff, "binary.bin").binary,
        additions: fileByPath(diff, "binary.bin").additions,
        deletions: fileByPath(diff, "binary.bin").deletions,
      },
      { status: "binary", binary: true, additions: null, deletions: null },
    );
    assert.match(diff.patch, /diff --git a\/staged\.txt b\/staged\.txt/);
    assert.match(diff.patch, /diff --git a\/modify\.txt b\/modify\.txt/);
    assert.match(diff.patch, /diff --git a\/untracked\.txt b\/untracked\.txt/);
  });
});

test("workspace diff service marks binary and oversize untracked files without embedding their content", async () => {
  const dir = tempDir();
  writeBundle(dir);
  initGitRepo(dir);
  writeFileSync(join(dir, "tracked.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  writeFileSync(join(dir, "large-untracked.txt"), "x".repeat(70 * 1024));
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const diff = await getWorkspaceDiff(outcome.workspaceDir, { mode: "working-tree" });
    assert.deepEqual(
      {
        status: fileByPath(diff, "large-untracked.txt").status,
        binary: fileByPath(diff, "large-untracked.txt").binary,
        additions: fileByPath(diff, "large-untracked.txt").additions,
        deletions: fileByPath(diff, "large-untracked.txt").deletions,
      },
      { status: "binary", binary: true, additions: null, deletions: null },
    );
    assert.doesNotMatch(diff.patch, /large-untracked/);
  });
});

test("workspace diff service truncates oversized patches", async () => {
  const dir = tempDir();
  writeBundle(dir);
  initGitRepo(dir);
  writeFileSync(join(dir, "big.txt"), "base\n");
  git(dir, ["add", "."]);
  git(dir, ["commit", "-m", "base"]);
  writeFileSync(join(dir, "big.txt"), `${"changed\n".repeat(90_000)}`);
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const diff = await getWorkspaceDiff(outcome.workspaceDir, { mode: "working-tree" });
    assert.equal(diff.truncated, true);
    assert.equal(diff.maxBytes, MAX_WORKSPACE_DIFF_BYTES);
    assert.ok(Buffer.byteLength(diff.patch) <= MAX_WORKSPACE_DIFF_BYTES);
    assert.equal(fileByPath(diff, "big.txt").status, "modified");
  });
});
