import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v18.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v18-"));
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

function baseV17Manifest(runId = "run-a") {
  return {
    schemaVersion: 17,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "codex",
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
    updatedAt: "2026-04-24T00:00:00.000Z",
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
      backend: "codex",
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

test("migrate-manifests-v18 dry-runs v17 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV17Manifest("run-a"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-a\/run\.json: would promote to schemaVersion 18/);
  assert.match(stdout, /SUMMARY migrated=1 conversionErrors=0/);
  assert.equal(readJson(manifestPath).schemaVersion, 17);
  assert.equal("queuedResumeMessages" in readJson(manifestPath), false);
});

test("migrate-manifests-v18 writes queuedResumeMessages array", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-ready", baseV17Manifest("run-ready"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-ready\/run\.json: promoted to schemaVersion 18/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 18);
  assert.deepEqual(manifest.queuedResumeMessages, []);
});

test("migrate-manifests-v18 supports repo and file filters", () => {
  const root = tempDir();
  const repoA = writeManifest(root, "repo-a", "run-a", baseV17Manifest("run-a"));
  const repoB = writeManifest(root, "repo-b", "run-b", baseV17Manifest("run-b"));
  const repoC = writeManifest(root, "repo-c", "run-c", baseV17Manifest("run-c"));

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "repo-a", "--write"], {
    encoding: "utf8",
  });
  assert.equal(readJson(repoA).schemaVersion, 18);
  assert.equal(readJson(repoB).schemaVersion, 17);

  execFileSync("node", [SCRIPT_PATH, "--file", repoB, "--write"], { encoding: "utf8" });
  assert.equal(readJson(repoB).schemaVersion, 18);
  assert.equal(readJson(repoC).schemaVersion, 17);
});

test("migrate-manifests-v18 reports canonical v18 manifests as no-op", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-v18", {
    ...baseV17Manifest("run-v18"),
    schemaVersion: 18,
    queuedResumeMessages: [],
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v18\/run\.json: already canonical schemaVersion 18/);
  assert.match(stdout, /SUMMARY migrated=0 conversionErrors=0/);
});

test("migrate-manifests-v18 rejects running and unsupported manifests", () => {
  const root = tempDir();
  const running = writeManifest(root, "demo", "run-running", {
    ...baseV17Manifest("run-running"),
    status: "running",
  });
  writeManifest(root, "demo", "run-old", { ...baseV17Manifest("run-old"), schemaVersion: 16 });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 17 manifest is running/);
  assert.match(result.stdout, /unsupported schemaVersion 16/);
  assert.equal(readJson(running).schemaVersion, 17);
  assert.equal("queuedResumeMessages" in readJson(running), false);
});

test("migrate-manifests-v18 rejects malformed manifests", () => {
  const root = tempDir();
  writeManifest(root, "demo", "bad-v17", {
    ...baseV17Manifest("bad-v17"),
    queuedResumeMessages: [],
  });
  writeManifest(root, "demo", "bad-v18", {
    ...baseV17Manifest("bad-v18"),
    schemaVersion: 18,
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 17 manifest already contains queuedResumeMessages/);
  assert.match(result.stdout, /schemaVersion 18 manifest is missing queuedResumeMessages array/);
});
