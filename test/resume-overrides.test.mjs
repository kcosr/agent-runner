import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { deriveRepoKey } from "../packages/core/dist/config/runtime-paths.js";
import { ResumeError, resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-resume-target-"));
}

function withStateRoot(stateDir, fn) {
  return withEnv(
    {
      TASK_RUNNER_STATE_DIR: stateDir,
      TASK_RUNNER_CONFIG_DIR: stateDir,
    },
    fn,
  );
}

function writeManifest(stateDir, repoName, runId, manifest) {
  const workspaceDir = join(stateDir, "runs", repoName, runId);
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return workspaceDir;
}

test("resolveResumeTarget prefers the current repo-name bucket over unknown for short ids", () => {
  const stateDir = tempDir();
  const repoName = deriveRepoKey(process.cwd());

  const repoWorkspace = writeManifest(
    stateDir,
    repoName,
    "shared1",
    baseManifest("shared1", join(stateDir, "runs", repoName, "shared1")),
  );
  writeManifest(
    stateDir,
    "unknown",
    "shared1",
    baseManifest("shared1", join(stateDir, "runs", "unknown", "shared1")),
  );

  const resolved = withStateRoot(stateDir, () => resolveResumeTarget("shared1", process.cwd()));
  assert.equal(resolved.workspaceDir, repoWorkspace);
});

test("resolveResumeTarget falls back to the unknown bucket when the repo-name bucket is missing", () => {
  const stateDir = tempDir();
  const unknownWorkspace = writeManifest(
    stateDir,
    "unknown",
    "fallback1",
    baseManifest("fallback1", join(stateDir, "runs", "unknown", "fallback1")),
  );

  const resolved = withStateRoot(stateDir, () => resolveResumeTarget("fallback1", process.cwd()));
  assert.equal(resolved.workspaceDir, unknownWorkspace);
});

test("resolveResumeTarget missing short ids list both checked directories", () => {
  const stateDir = tempDir();
  const repoName = deriveRepoKey(process.cwd());

  assert.throws(
    () => withStateRoot(stateDir, () => resolveResumeTarget("missing1", process.cwd())),
    (error) => {
      assert.ok(error instanceof ResumeError);
      assert.match(error.message, new RegExp(`runs/${repoName}/missing1/`));
      assert.match(error.message, /runs\/unknown\/missing1\//);
      return true;
    },
  );
});

test("resolveResumeTarget rejects a manifest with finalTasks: null", () => {
  const dir = tempDir();
  const workspaceDir = writeManifest(
    dir,
    "unknown",
    "corrupt1",
    Object.assign(baseManifest("corrupt1", join(dir, "runs", "unknown", "corrupt1")), {
      finalTasks: null,
    }),
  );
  assert.equal(workspaceDir, join(dir, "runs", "unknown", "corrupt1"));

  assert.throws(
    () => withStateRoot(dir, () => resolveResumeTarget("corrupt1", dir)),
    (err) => {
      assert.ok(err instanceof ResumeError);
      assert.match(err.message, /does not look like a task-runner run\.json/);
      return true;
    },
  );
});

test("resolveResumeTarget rejects a manifest missing assignmentPath", () => {
  const dir = tempDir();
  const manifest = baseManifest("corrupt2", join(dir, "runs", "unknown", "corrupt2"));
  manifest.assignmentPath = undefined;
  writeManifest(dir, "unknown", "corrupt2", manifest);

  assert.throws(
    () => withStateRoot(dir, () => resolveResumeTarget("corrupt2", dir)),
    (err) => {
      assert.ok(err instanceof ResumeError);
      assert.match(err.message, /does not look like a task-runner run\.json/);
      return true;
    },
  );
});

test("resolveResumeTarget rejects a manifest with runtimeVars: null", () => {
  const dir = tempDir();
  const manifest = baseManifest("corrupt3", join(dir, "runs", "unknown", "corrupt3"));
  manifest.runtimeVars = null;
  writeManifest(dir, "unknown", "corrupt3", manifest);

  assert.throws(
    () => withStateRoot(dir, () => resolveResumeTarget("corrupt3", dir)),
    (err) => {
      assert.ok(err instanceof ResumeError);
      assert.match(err.message, /does not look like a task-runner run\.json/);
      return true;
    },
  );
});

test("resolveResumeTarget accepts a well-formed v3 manifest from the unknown bucket", () => {
  const dir = tempDir();
  const workspaceDir = join(dir, "runs", "unknown", "wellformed");
  writeManifest(dir, "unknown", "wellformed", baseManifest("wellformed", workspaceDir));

  const resolved = withStateRoot(dir, () => resolveResumeTarget("wellformed", dir));
  assert.equal(resolved.manifest.runId, "wellformed");
  assert.equal(resolved.manifest.schemaVersion, 3);
});

function baseManifest(runId, workspaceDir) {
  return {
    schemaVersion: 3,
    runId,
    agent: {
      name: "override-test",
      sourcePath: null,
      instructions: "",
    },
    assignment: null,
    backend: "claude",
    model: "claude-sonnet-4-6",
    effort: null,
    message: null,
    name: null,
    unrestricted: false,
    cwd: process.cwd(),
    lockedFields: [],
    timeoutSec: 3600,
    assignmentPath: join(workspaceDir, "assignment.md"),
    workspaceDir,
    startedAt: "2026-04-11T16:00:00Z",
    endedAt: "2026-04-11T16:05:00Z",
    status: "success",
    exitCode: 0,
    attempts: 1,
    maxAttempts: 4,
    tasksCompleted: 1,
    tasksTotal: 1,
    backendSessionId: "sess-base",
    runtimeVars: {},
    pendingPrompt: null,
    callerInstructions: null,
    resetSeed: {
      model: "claude-sonnet-4-6",
      effort: null,
      name: null,
      unrestricted: false,
      timeoutSec: 3600,
      maxAttempts: 4,
      pendingPrompt: "seed prompt",
      finalTasks: {
        t1: {
          id: "t1",
          title: "First",
          body: "",
          status: "pending",
          notes: "",
        },
      },
    },
    finalTasks: {
      t1: {
        id: "t1",
        title: "First",
        body: "",
        status: "completed",
        notes: "",
      },
    },
    sessionCount: 1,
    sessions: [],
    attemptRecords: [],
  };
}
