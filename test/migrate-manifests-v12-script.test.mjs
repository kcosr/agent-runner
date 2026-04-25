import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v12.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v12-"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeManifest(root, repo, runId, manifest) {
  const dir = join(root, "runs", repo, runId);
  mkdirSync(dir, { recursive: true });
  writeJson(join(dir, "run.json"), {
    ...manifest,
    workspaceDir: dir,
    assignmentPath: join(dir, "assignment-seed.md"),
  });
  return dir;
}

function baseV11Manifest(runId = "run-v11") {
  return {
    schemaVersion: 11,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    launcher: { kind: "direct", name: "direct" },
    message: null,
    name: null,
    note: null,
    pinned: false,
    unrestricted: false,
    cwd: "/repo",
    lockedFields: [],
    timeoutSec: 10,
    workspaceDir: "/state/run",
    assignmentPath: "/state/run/assignment-seed.md",
    startedAt: "2026-04-24T00:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "ready",
    dependencyRunIds: [],
    parentRunId: null,
    exitCode: null,
    totalAttemptCount: 0,
    maxAttemptsPerSession: 3,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: null,
    runtimeVars: {},
    runtimeVarSources: {},
    execution: { hostMode: "embedded", controller: { kind: "embedded" } },
    brief: "brief",
    resolvedHooks: [],
    hookState: {},
    hookAudits: [],
    callerInstructions: null,
    resetSeed: {
      backend: "claude",
      model: null,
      effort: null,
      launcher: { kind: "direct", name: "direct" },
      cwd: "/repo",
      lockedFields: [],
      message: null,
      name: null,
      note: null,
      pinned: false,
      dependencyRunIds: [],
      parentRunId: null,
      unrestricted: false,
      timeoutSec: 10,
      maxAttemptsPerSession: 3,
      brief: "brief",
      runtimeVars: {},
      runtimeVarSources: {},
      hookState: {},
      attachments: [],
      finalTasks: {},
    },
    attachments: [],
    finalTasks: {},
    totalSessionCount: 0,
    sessions: [],
    attemptRecords: [],
  };
}

test("migrate-manifests-v12 dry-runs v11 promotion without writing", () => {
  const root = tempDir();
  const runDir = writeManifest(root, "demo", "run-v11", baseV11Manifest());

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-v11\/run\.json: would promote to schemaVersion 12/);
  assert.equal(readJson(join(runDir, "run.json")).schemaVersion, 11);
  assert.equal("schedule" in readJson(join(runDir, "run.json")), false);
});

test("migrate-manifests-v12 writes v11 manifest promotion", () => {
  const root = tempDir();
  const runDir = writeManifest(root, "demo", "run-v11", baseV11Manifest());

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-v11\/run\.json: promoted to schemaVersion 12/);
  const manifest = readJson(join(runDir, "run.json"));
  assert.equal(manifest.schemaVersion, 12);
  assert.equal(manifest.schedule, null);
  assert.equal("schedule" in manifest.resetSeed, false);
});

test("schemaVersion 11 manifest is rejected with v12 migration hint", () => {
  const root = tempDir();
  writeManifest(root, "unknown", "run-v11", baseV11Manifest("run-v11"));

  withSharedRuntimeEnv(root, () => {
    assert.throws(
      () => resolveResumeTarget("run-v11", root),
      (err) => {
        assert.match(err.message, /schemaVersion 11/);
        assert.match(err.message, /requires schemaVersion 12/);
        assert.match(err.message, /scripts\/migrate-manifests-v12\.mjs/);
        return true;
      },
    );
  });
});

test("migrate-manifests-v12 rejects v11 manifests that already contain schedule", () => {
  const root = tempDir();
  const manifest = { ...baseV11Manifest(), schedule: null };
  writeManifest(root, "demo", "run-v11", manifest);

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-v11\/run\.json:/);
  assert.match(result.stdout, /schemaVersion 11 manifest must not already contain schedule/);
});
