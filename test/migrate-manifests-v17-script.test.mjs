import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v17.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v17-"));
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

function baseV16Manifest(runId = "run-a") {
  return {
    schemaVersion: 16,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "codex",
    model: null,
    effort: null,
    backendSpecific: {
      codex: {
        transport: { type: "ws", url: "ws://127.0.0.1:4773/" },
      },
    },
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
      backendSpecific: {
        codex: {
          transport: { type: "ws", url: "ws://127.0.0.1:4773/" },
        },
      },
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

test("migrate-manifests-v17 dry-runs v16 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV16Manifest("run-a"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-a\/run\.json: would promote to schemaVersion 17/);
  assert.match(stdout, /SUMMARY migrated=1 conversionErrors=0/);
  assert.equal(readJson(manifestPath).schemaVersion, 16);
  assert.equal("backendSpecific" in readJson(manifestPath), true);
});

test("migrate-manifests-v17 writes selected-only Codex backendConfig", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-codex", baseV16Manifest("run-codex"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-codex\/run\.json: promoted to schemaVersion 17/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 17);
  assert.deepEqual(manifest.backendConfig, {
    transport: { type: "ws", url: "ws://127.0.0.1:4773/" },
  });
  assert.equal("backendSpecific" in manifest, false);
  assert.deepEqual(manifest.resetSeed.backendConfig, manifest.backendConfig);
  assert.equal("backendSpecific" in manifest.resetSeed, false);
});

test("migrate-manifests-v17 drops old Codex-only config for non-Codex runs", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-claude", {
    ...baseV16Manifest("run-claude"),
    backend: "claude",
    resetSeed: {
      ...baseV16Manifest("run-claude").resetSeed,
      backend: "claude",
    },
  });

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], { encoding: "utf8" });

  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 17);
  assert.equal("backendConfig" in manifest, false);
  assert.equal("backendSpecific" in manifest, false);
  assert.equal("backendConfig" in manifest.resetSeed, false);
  assert.equal("backendSpecific" in manifest.resetSeed, false);
});

test("migrate-manifests-v17 supports repo and file filters", () => {
  const root = tempDir();
  const repoA = writeManifest(root, "repo-a", "run-a", baseV16Manifest("run-a"));
  const repoB = writeManifest(root, "repo-b", "run-b", baseV16Manifest("run-b"));
  const repoC = writeManifest(root, "repo-c", "run-c", baseV16Manifest("run-c"));

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "repo-a", "--write"], {
    encoding: "utf8",
  });
  assert.equal(readJson(repoA).schemaVersion, 17);
  assert.equal(readJson(repoB).schemaVersion, 16);

  execFileSync("node", [SCRIPT_PATH, "--file", repoB, "--write"], { encoding: "utf8" });
  assert.equal(readJson(repoB).schemaVersion, 17);
  assert.equal(readJson(repoC).schemaVersion, 16);
});

test("migrate-manifests-v17 reports canonical v17 manifests as no-op", () => {
  const root = tempDir();
  const { backendSpecific: _backendSpecific, ...resetSeed } = baseV16Manifest("run-v17").resetSeed;
  writeManifest(root, "demo", "run-v17", {
    ...baseV16Manifest("run-v17"),
    schemaVersion: 17,
    backendConfig: { transport: { type: "stdio" } },
    resetSeed: {
      ...resetSeed,
      backendConfig: { transport: { type: "stdio" } },
    },
    backendSpecific: undefined,
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v17\/run\.json: already canonical schemaVersion 17/);
  assert.match(stdout, /SUMMARY migrated=0 conversionErrors=0/);
});

test("migrate-manifests-v17 rejects running and unsupported manifests", () => {
  const root = tempDir();
  const running = writeManifest(root, "demo", "run-running", {
    ...baseV16Manifest("run-running"),
    status: "running",
  });
  writeManifest(root, "demo", "run-old", { ...baseV16Manifest("run-old"), schemaVersion: 15 });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 16 manifest is running/);
  assert.match(result.stdout, /unsupported schemaVersion 15/);
  assert.equal(readJson(running).schemaVersion, 16);
  assert.equal("backendSpecific" in readJson(running), true);
});

test("migrate-manifests-v17 rejects malformed manifests", () => {
  const root = tempDir();
  writeManifest(root, "demo", "missing-reset", {
    ...baseV16Manifest("missing-reset"),
    resetSeed: undefined,
  });
  writeManifest(root, "demo", "bad-backend-specific", {
    ...baseV16Manifest("bad-backend-specific"),
    backendSpecific: null,
  });
  writeManifest(root, "demo", "bad-v17", {
    ...baseV16Manifest("bad-v17"),
    schemaVersion: 17,
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 16 manifest is missing resetSeed object/);
  assert.match(result.stdout, /schemaVersion 16 manifest backendSpecific must be an object/);
  assert.match(result.stdout, /schemaVersion 17 manifest still contains backendSpecific/);
  assert.match(result.stdout, /SUMMARY migrated=0 conversionErrors=3/);
});

test("migrate-manifests-v17 rejects file and repo filters together", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV16Manifest("run-a"));

  const result = spawnSync("node", [SCRIPT_PATH, "--file", manifestPath, "--repo", "demo"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--file cannot be combined with --repo/);
  assert.match(result.stderr, /Usage: node scripts\/migrate-manifests-v17\.mjs/);
});
