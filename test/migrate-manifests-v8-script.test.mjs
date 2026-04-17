import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v8.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v8-"));
}

function writeManifest(root, repo, runId, manifest) {
  const dir = join(root, "runs", repo, runId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  return join(dir, "run.json");
}

function readManifest(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

test("migrate-manifests-v8 script dry-runs v7 manifests and rejects broken v8 manifests", () => {
  const root = join(tempDir(), "agent-runner");
  const v7Path = writeManifest(root, "demo", "run-v7", {
    schemaVersion: 7,
    runId: "run-v7",
    cwd: "/repo",
    assignmentPath: "/state/runs/demo/run-v7/assignment.md",
    workspaceDir: "/state/runs/demo/run-v7",
  });
  writeManifest(root, "demo", "run-v8-broken", {
    schemaVersion: 8,
    runId: "run-v8-broken",
    repo: "",
  });
  writeManifest(root, "demo", "run-v8", {
    schemaVersion: 8,
    runId: "run-v8",
    repo: "demo",
  });

  let error;
  let stdout = "";
  try {
    stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    error = err;
    stdout = err.stdout.toString();
    assert.equal(err.status, 1);
    assert.match(
      err.stderr.toString(),
      /run-v8-broken\/run\.json: schemaVersion 8 manifest is missing repo string/,
    );
  }
  assert.ok(error);
  assert.match(stdout, /DRY\s+.*run-v7\/run\.json/);
  assert.match(stdout, /OK\s+.*run-v8\/run\.json/);
  assert.equal(readManifest(v7Path).schemaVersion, 7);
});

test("migrate-manifests-v8 script writes v7 repo capture upgrades", () => {
  const root = join(tempDir(), "agent-runner");
  const v7Path = writeManifest(root, "demo", "run-v7", {
    schemaVersion: 7,
    runId: "run-v7",
    cwd: "/repo",
    assignmentPath: "/legacy/runs/demo/run-v7/assignment.md",
    workspaceDir: "/legacy/runs/demo/run-v7",
    archivedAt: undefined,
    brief: "Current brief",
  });
  const validV8Path = writeManifest(root, "demo", "run-v8", {
    schemaVersion: 8,
    runId: "run-v8",
    repo: "demo",
  });

  const writeRun = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(writeRun, /WRITE\s+.*run-v7\/run\.json/);
  assert.match(writeRun, /OK\s+.*run-v8\/run\.json/);
  assert.deepEqual(readManifest(v7Path), {
    schemaVersion: 8,
    runId: "run-v7",
    repo: "demo",
    cwd: "/repo",
    assignmentPath: "/legacy/runs/demo/run-v7/assignment.md",
    workspaceDir: "/legacy/runs/demo/run-v7",
    archivedAt: null,
    brief: "Current brief",
  });
  assert.deepEqual(readManifest(validV8Path), {
    schemaVersion: 8,
    runId: "run-v8",
    repo: "demo",
  });
});

test("migrate-manifests-v8 script filters to selected repo buckets", () => {
  const root = join(tempDir(), "agent-runner");
  const taskRunnerPath = writeManifest(root, "task-runner", "run-task-runner", {
    schemaVersion: 7,
    runId: "run-task-runner",
    cwd: "/repos/task-runner",
  });
  const assistantPath = writeManifest(root, "assistant", "run-assistant", {
    schemaVersion: 7,
    runId: "run-assistant",
    cwd: "/repos/assistant",
  });

  const writeRun = execFileSync(
    "node",
    [SCRIPT_PATH, "--root", root, "--repo", "task-runner", "--write"],
    {
      encoding: "utf8",
    },
  );

  assert.match(writeRun, /WRITE\s+.*run-task-runner\/run\.json/);
  assert.match(writeRun, /SKIP\s+.*run-assistant\/run\.json: repo bucket assistant not selected/);
  assert.deepEqual(readManifest(taskRunnerPath), {
    schemaVersion: 8,
    runId: "run-task-runner",
    repo: "task-runner",
    cwd: "/repos/task-runner",
    archivedAt: null,
  });
  assert.deepEqual(readManifest(assistantPath), {
    schemaVersion: 7,
    runId: "run-assistant",
    cwd: "/repos/assistant",
  });
});
