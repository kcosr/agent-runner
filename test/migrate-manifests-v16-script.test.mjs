import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v16.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v16-"));
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
  const manifestPath = join(dir, "run.json");
  writeJson(manifestPath, { ...manifest, runId, repo, workspaceDir: dir });
  return manifestPath;
}

function baseV15Manifest(runId = "run-a") {
  return {
    schemaVersion: 15,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    resolvedBackendArgs: [],
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
    startedAt: "2026-04-24T00:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "ready",
    runGroupId: runId,
    dependencies: [],
    parentRunId: null,
    schedule: null,
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
      resolvedBackendArgs: [],
      launcher: { kind: "direct", name: "direct" },
      cwd: "/repo",
      lockedFields: [],
      message: null,
      name: null,
      note: null,
      pinned: false,
      runGroupId: runId,
      dependencies: [],
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

test("migrate-manifests-v16 dry-runs v15 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV15Manifest("run-a"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-a\/run\.json: would promote to schemaVersion 16/);
  assert.match(stdout, /SUMMARY migrated=1 conversionErrors=0/);
  assert.equal(readJson(manifestPath).schemaVersion, 15);
  assert.equal("updatedAt" in readJson(manifestPath), false);
});

test("migrate-manifests-v16 writes updatedAt from endedAt when present", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-ended", {
    ...baseV15Manifest("run-ended"),
    endedAt: "2026-04-24T01:00:00.000Z",
    status: "success",
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-ended\/run\.json: promoted to schemaVersion 16/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 16);
  assert.equal(manifest.updatedAt, "2026-04-24T01:00:00.000Z");
  assert.equal(manifest.startedAt, "2026-04-24T00:00:00.000Z");
  assert.equal(manifest.endedAt, "2026-04-24T01:00:00.000Z");
});

test("migrate-manifests-v16 writes updatedAt from startedAt when endedAt is null", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-ready", baseV15Manifest("run-ready"));

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], { encoding: "utf8" });

  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 16);
  assert.equal(manifest.updatedAt, "2026-04-24T00:00:00.000Z");
});

test("migrate-manifests-v16 supports repo and file filters", () => {
  const root = tempDir();
  const repoA = writeManifest(root, "repo-a", "run-a", baseV15Manifest("run-a"));
  const repoB = writeManifest(root, "repo-b", "run-b", baseV15Manifest("run-b"));
  const repoC = writeManifest(root, "repo-c", "run-c", baseV15Manifest("run-c"));

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "repo-a", "--write"], {
    encoding: "utf8",
  });
  assert.equal(readJson(repoA).schemaVersion, 16);
  assert.equal(readJson(repoB).schemaVersion, 15);

  execFileSync("node", [SCRIPT_PATH, "--file", repoB, "--write"], { encoding: "utf8" });
  assert.equal(readJson(repoB).schemaVersion, 16);
  assert.equal(readJson(repoC).schemaVersion, 15);
});

test("migrate-manifests-v16 reports canonical v16 manifests as no-op", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-v16", {
    ...baseV15Manifest("run-v16"),
    schemaVersion: 16,
    updatedAt: "2026-04-25T00:00:00.000Z",
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v16\/run\.json: already canonical schemaVersion 16/);
  assert.match(stdout, /SUMMARY migrated=0 conversionErrors=0/);
});

test("migrate-manifests-v16 rejects running and unsupported manifests", () => {
  const root = tempDir();
  const running = writeManifest(root, "demo", "run-running", {
    ...baseV15Manifest("run-running"),
    status: "running",
  });
  writeManifest(root, "demo", "run-old", { ...baseV15Manifest("run-old"), schemaVersion: 14 });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 15 manifest is running/);
  assert.match(result.stdout, /unsupported schemaVersion 14/);
  assert.equal(readJson(running).schemaVersion, 15);
  assert.equal("updatedAt" in readJson(running), false);
});

test("migrate-manifests-v16 rejects malformed manifests", () => {
  const root = tempDir();
  writeManifest(root, "demo", "missing-start", {
    ...baseV15Manifest("missing-start"),
    startedAt: undefined,
  });
  writeManifest(root, "demo", "bad-ended", {
    ...baseV15Manifest("bad-ended"),
    endedAt: 123,
  });
  writeManifest(root, "demo", "bad-v16", {
    ...baseV15Manifest("bad-v16"),
    schemaVersion: 16,
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 15 manifest is missing startedAt string/);
  assert.match(result.stdout, /schemaVersion 15 manifest endedAt must be a string or null/);
  assert.match(result.stdout, /schemaVersion 16 manifest is missing updatedAt string/);
  assert.match(result.stdout, /SUMMARY migrated=0 conversionErrors=3/);
});
