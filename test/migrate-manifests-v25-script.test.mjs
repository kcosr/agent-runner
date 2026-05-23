import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v25.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v25-"));
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

function baseSession() {
  return {
    sessionIndex: 0,
    startedAt: "2026-04-24T00:00:00.000Z",
    endedAt: "2026-04-24T00:01:00.000Z",
    status: "success",
    exitCode: 0,
    message: "work",
    brief: "brief",
    firstAttemptNumber: 0,
    lastAttemptNumber: 0,
    maxAttemptsPerSession: 3,
    backendSessionIdAtStart: null,
    backendSessionIdAtEnd: null,
    provenance: { kind: "task_runner" },
  };
}

function baseV24Manifest(runId = "run-a") {
  return {
    schemaVersion: 24,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "codex",
    model: null,
    effort: null,
    resolvedBackendArgs: [],
    launcher: { kind: "direct", name: "direct" },
    executionEnvironment: null,
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
    queuedResumeMessages: [
      {
        id: "qmsg1",
        text: "queued",
        createdAt: "2026-04-24T00:00:30.000Z",
      },
    ],
    exitCode: null,
    totalAttemptCount: 0,
    maxAttemptsPerSession: 3,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: null,
    backendSessionSync: null,
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
      executionEnvironment: null,
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
    sessions: [baseSession()],
    attemptRecords: [],
  };
}

test("migrate-manifests-v25 dry-runs v24 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-a", baseV24Manifest("run-a"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-a\/run\.json: would promote to schemaVersion 25/);
  assert.match(stdout, /SUMMARY migrated=1 conversionErrors=0/);
  assert.equal(readJson(manifestPath).schemaVersion, 24);
  assert.equal("parentCompletionNotifications" in readJson(manifestPath), false);
  assert.equal("source" in readJson(manifestPath).queuedResumeMessages[0], false);
  assert.equal("resumeSource" in readJson(manifestPath).sessions[0], false);
});

test("migrate-manifests-v25 writes notification and source defaults", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-ready", baseV24Manifest("run-ready"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-ready\/run\.json: promoted to schemaVersion 25/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 25);
  assert.deepEqual(manifest.parentCompletionNotifications, []);
  assert.deepEqual(
    manifest.queuedResumeMessages.map((message) => message.source),
    [null],
  );
  assert.deepEqual(
    manifest.sessions.map((session) => session.resumeSource),
    [null],
  );
});

test("migrate-manifests-v25 supports repo and file filters", () => {
  const root = tempDir();
  const repoA = writeManifest(root, "repo-a", "run-a", baseV24Manifest("run-a"));
  const repoB = writeManifest(root, "repo-b", "run-b", baseV24Manifest("run-b"));
  const repoC = writeManifest(root, "repo-c", "run-c", baseV24Manifest("run-c"));

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "repo-a", "--write"], {
    encoding: "utf8",
  });
  assert.equal(readJson(repoA).schemaVersion, 25);
  assert.equal(readJson(repoB).schemaVersion, 24);

  execFileSync("node", [SCRIPT_PATH, "--file", repoB, "--write"], { encoding: "utf8" });
  assert.equal(readJson(repoB).schemaVersion, 25);
  assert.equal(readJson(repoC).schemaVersion, 24);
});

test("migrate-manifests-v25 reports canonical v25 manifests as no-op", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-v25", {
    ...baseV24Manifest("run-v25"),
    schemaVersion: 25,
    parentCompletionNotifications: [],
    queuedResumeMessages: [
      {
        id: "qmsg1",
        text: "queued",
        createdAt: "2026-04-24T00:00:30.000Z",
        source: null,
      },
    ],
    sessions: [{ ...baseSession(), resumeSource: null }],
  });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v25\/run\.json: already canonical schemaVersion 25/);
  assert.match(stdout, /SUMMARY migrated=0 conversionErrors=0/);
});

test("migrate-manifests-v25 rejects running and unsupported manifests", () => {
  const root = tempDir();
  const running = writeManifest(root, "demo", "run-running", {
    ...baseV24Manifest("run-running"),
    status: "running",
  });
  writeManifest(root, "demo", "run-old", { ...baseV24Manifest("run-old"), schemaVersion: 23 });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 24 manifest is running/);
  assert.match(result.stdout, /unsupported schemaVersion 23/);
  assert.equal(readJson(running).schemaVersion, 24);
  assert.equal("parentCompletionNotifications" in readJson(running), false);
});

test("migrate-manifests-v25 rejects malformed manifests", () => {
  const root = tempDir();
  writeManifest(root, "demo", "bad-v24-queued", {
    ...baseV24Manifest("bad-v24-queued"),
    queuedResumeMessages: null,
  });
  writeManifest(root, "demo", "bad-v24-sessions", {
    ...baseV24Manifest("bad-v24-sessions"),
    sessions: null,
  });
  writeManifest(root, "demo", "bad-v25", {
    ...baseV24Manifest("bad-v25"),
    schemaVersion: 25,
    queuedResumeMessages: [],
    sessions: [],
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /schemaVersion 24 manifest is missing queuedResumeMessages array/);
  assert.match(result.stdout, /schemaVersion 24 manifest is missing sessions array/);
  assert.match(
    result.stdout,
    /schemaVersion 25 manifest is missing parentCompletionNotifications array/,
  );
});
