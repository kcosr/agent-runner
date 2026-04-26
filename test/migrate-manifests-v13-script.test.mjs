import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v13.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v13-"));
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
  writeJson(manifestPath, manifest);
  return manifestPath;
}

function baseV12Manifest(runId = "run-v12") {
  return {
    schemaVersion: 12,
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

test("migrate-manifests-v13 dry-runs v12 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v12", baseV12Manifest());

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-v12\/run\.json: would promote to schemaVersion 13/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 12);
  assert.equal("resolvedBackendArgs" in manifest, false);
  assert.equal("resolvedBackendArgs" in manifest.resetSeed, false);
});

test("migrate-manifests-v13 writes v12 promotion", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v12", baseV12Manifest());

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-v12\/run\.json: promoted to schemaVersion 13/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 13);
  assert.deepEqual(manifest.resolvedBackendArgs, []);
  assert.deepEqual(manifest.resetSeed.resolvedBackendArgs, []);
});

test("migrate-manifests-v13 can target one manifest file", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v12", baseV12Manifest());
  const otherPath = writeManifest(root, "demo", "other-run", baseV12Manifest("other-run"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--file", manifestPath, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, new RegExp(`WRITE\\s+${manifestPath}: promoted to schemaVersion 13`));
  assert.equal(readJson(manifestPath).schemaVersion, 13);
  assert.equal(readJson(otherPath).schemaVersion, 12);
});

test("migrate-manifests-v13 reports no-op manifests as OK", () => {
  const root = tempDir();
  const canonical = {
    ...baseV12Manifest("run-v13"),
    schemaVersion: 13,
    resolvedBackendArgs: [],
    resetSeed: {
      ...baseV12Manifest("run-v13").resetSeed,
      resolvedBackendArgs: [],
    },
  };
  writeManifest(root, "demo", "run-v13", canonical);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v13\/run\.json: already canonical schemaVersion 13/);
});

test("migrate-manifests-v13 reports malformed manifests and continues", () => {
  const root = tempDir();
  const badJsonDir = join(root, "runs", "demo", "bad-json");
  const nonObjectDir = join(root, "runs", "demo", "non-object");
  mkdirSync(badJsonDir, { recursive: true });
  mkdirSync(nonObjectDir, { recursive: true });
  writeFileSync(join(badJsonDir, "run.json"), "{not json");
  writeJson(join(nonObjectDir, "run.json"), []);

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/bad-json\/run\.json: invalid JSON:/);
  assert.match(
    result.stdout,
    /ERROR\s+runs\/demo\/non-object\/run\.json: manifest must be an object/,
  );
});

test("migrate-manifests-v13 rejects file and repo filters together", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v12", baseV12Manifest());

  const result = spawnSync("node", [SCRIPT_PATH, "--file", manifestPath, "--repo", "demo"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--file cannot be combined with --repo/);
  assert.match(result.stderr, /Usage: node scripts\/migrate-manifests-v13\.mjs/);
});
