import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v19.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v19-"));
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

function baseV18Manifest(runId = "run-a") {
  return {
    schemaVersion: 18,
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
    queuedResumeMessages: [],
    exitCode: null,
    totalAttemptCount: 1,
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
    totalSessionCount: 1,
    sessions: [
      {
        sessionIndex: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:01:00.000Z",
        status: "success",
        exitCode: 0,
        message: "brief",
        brief: "brief",
        firstAttemptNumber: 0,
        lastAttemptNumber: 0,
        maxAttemptsPerSession: 3,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "backend-session",
      },
    ],
    attemptRecords: [
      {
        attemptNumber: 0,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:01:00.000Z",
        prompt: "brief",
        sessionIdAtStart: null,
        sessionIdCaptured: "backend-session",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "ok",
        logPath: "attempts/00.json",
        invalidStatuses: [],
      },
    ],
  };
}

test("migrate-manifests-v19 dry-runs v18 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV18Manifest("run-a"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-a\/run\.json: would promote to schemaVersion 19/);
  assert.match(stdout, /SUMMARY migrated=1 conversionErrors=0/);
  assert.equal(readJson(manifestPath).schemaVersion, 18);
  assert.equal("backendSessionSync" in readJson(manifestPath), false);
});

test("migrate-manifests-v19 writes sync state and agent-runner provenance", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-ready", baseV18Manifest("run-ready"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-ready\/run\.json: promoted to schemaVersion 19/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 19);
  assert.equal(manifest.backendSessionSync, null);
  assert.deepEqual(manifest.sessions[0].provenance, { kind: "task_runner" });
  assert.deepEqual(manifest.attemptRecords[0].provenance, { kind: "task_runner" });
});

test("migrate-manifests-v19 supports repo and file filters", () => {
  const root = tempDir();
  const repoA = writeManifest(root, "repo-a", "run-a", baseV18Manifest("run-a"));
  const repoB = writeManifest(root, "repo-b", "run-b", baseV18Manifest("run-b"));
  const repoC = writeManifest(root, "repo-c", "run-c", baseV18Manifest("run-c"));

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "repo-a", "--write"], {
    encoding: "utf8",
  });
  assert.equal(readJson(repoA).schemaVersion, 19);
  assert.equal(readJson(repoB).schemaVersion, 18);

  execFileSync("node", [SCRIPT_PATH, "--file", repoB, "--write"], { encoding: "utf8" });
  assert.equal(readJson(repoB).schemaVersion, 19);
  assert.equal(readJson(repoC).schemaVersion, 18);
});

test("migrate-manifests-v19 reports canonical v19 manifests as no-op", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-v18", {
    ...baseV18Manifest("run-v18"),
    schemaVersion: 19,
    backendSessionSync: null,
    sessions: baseV18Manifest("run-v18").sessions.map((session) => ({
      ...session,
      provenance: { kind: "task_runner" },
    })),
    attemptRecords: baseV18Manifest("run-v18").attemptRecords.map((attempt) => ({
      ...attempt,
      provenance: { kind: "task_runner" },
    })),
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v18\/run\.json: already canonical schemaVersion 19/);
  assert.match(stdout, /SUMMARY migrated=0 conversionErrors=0/);
});

test("migrate-manifests-v19 rejects running and unsupported manifests", () => {
  const root = tempDir();
  const running = writeManifest(root, "demo", "run-running", {
    ...baseV18Manifest("run-running"),
    status: "running",
  });
  writeManifest(root, "demo", "run-old", { ...baseV18Manifest("run-old"), schemaVersion: 17 });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 18 manifest is running/);
  assert.match(result.stdout, /unsupported schemaVersion 17/);
  assert.equal(readJson(running).schemaVersion, 18);
  assert.equal("backendSessionSync" in readJson(running), false);
});

test("migrate-manifests-v19 rejects malformed manifests", () => {
  const root = tempDir();
  writeManifest(root, "demo", "bad-v17", {
    ...baseV18Manifest("bad-v17"),
    backendSessionSync: null,
  });
  writeManifest(root, "demo", "bad-v18", {
    ...baseV18Manifest("bad-v18"),
    schemaVersion: 19,
    backendSessionSync: null,
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 18 manifest already contains backendSessionSync/);
  assert.match(
    result.stdout,
    /schemaVersion 19 manifest attempt 0 is missing task_runner provenance/,
  );
});
