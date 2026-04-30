import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v11.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-v11-"));
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeManifest(root, repo, runId, manifest) {
  const dir = join(root, "runs", repo, runId);
  mkdirSync(join(dir, "attempts"), { recursive: true });
  writeJson(join(dir, "run.json"), manifest);
  return dir;
}

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function baseV10Manifest(runId = "run-v10") {
  return {
    schemaVersion: 10,
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
    assignmentPath: "/state/assignment-seed.md",
    workspaceDir: "/state/run",
    startedAt: "2026-04-24T00:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "success",
    dependencyRunIds: [],
    parentRunId: null,
    exitCode: 0,
    attempts: 2,
    maxAttempts: 3,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: "thread-1",
    runtimeVars: {},
    runtimeVarSources: {},
    execution: { hostMode: "embedded", controller: { kind: "embedded" } },
    brief: "brief",
    resolvedHooks: [],
    hookState: {},
    hookAudits: [
      {
        phase: "beforeAttempt",
        hookId: "beforeAttempt:0:command",
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:00:01.000Z",
        outcome: "continue",
        sessionIndex: 0,
        attempt: 1,
        taskId: null,
        summary: null,
      },
    ],
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
      maxAttempts: 3,
      brief: "brief",
      runtimeVars: {},
      runtimeVarSources: {},
      hookState: {},
      attachments: [],
      finalTasks: {},
    },
    attachments: [],
    finalTasks: {},
    sessionCount: 1,
    sessions: [
      {
        sessionIndex: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:02:00.000Z",
        status: "success",
        exitCode: 0,
        message: null,
        brief: "brief",
        firstAttempt: 1,
        lastAttempt: 2,
        maxAttempts: 3,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "thread-1",
      },
    ],
    attemptRecords: [
      {
        attempt: 2,
        sessionIndex: 0,
        startedAt: "2026-04-24T00:01:00.000Z",
        endedAt: "2026-04-24T00:02:00.000Z",
        prompt: "again",
        sessionIdAtStart: "thread-1",
        sessionIdCaptured: "thread-1",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "done",
        logPath: "attempts/02.json",
        tasksAfter: {},
        invalidStatuses: [],
      },
      {
        attempt: 1,
        sessionIndex: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:01:00.000Z",
        prompt: "start",
        sessionIdAtStart: null,
        sessionIdCaptured: "thread-1",
        exitCode: 1,
        signal: null,
        timedOut: false,
        transcript: "try",
        logPath: "attempts/01.json",
        tasksAfter: {},
        invalidStatuses: [],
      },
    ],
  };
}

function writeAttemptLogs(dir) {
  writeJson(join(dir, "attempts", "01.json"), {
    schemaVersion: 1,
    runId: "run-v10",
    attempt: 1,
    sessionIndex: 0,
    startedAt: "2026-04-24T00:00:00.000Z",
    endedAt: "2026-04-24T00:01:00.000Z",
    stdout: "stdout-1",
    stderr: "stderr-1",
  });
  writeJson(join(dir, "attempts", "02.json"), {
    schemaVersion: 1,
    runId: "run-v10",
    attempt: 2,
    sessionIndex: 0,
    startedAt: "2026-04-24T00:01:00.000Z",
    endedAt: "2026-04-24T00:02:00.000Z",
    stdout: "stdout-2",
    stderr: "stderr-2",
  });
}

test("migrate-manifests-v11 dry-runs v10 promotion without writing", () => {
  const root = tempDir();
  const runDir = writeManifest(root, "demo", "run-v10", baseV10Manifest());
  writeAttemptLogs(runDir);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-v10\/run\.json: would promote to schemaVersion 11/);
  assert.equal(readJson(join(runDir, "run.json")).schemaVersion, 10);
  assert.equal(readJson(join(runDir, "attempts", "01.json")).schemaVersion, 1);
});

test("migrate-manifests-v11 writes v10 manifest and attempt log promotion", () => {
  const root = tempDir();
  const runDir = writeManifest(root, "demo", "run-v10", baseV10Manifest());
  writeAttemptLogs(runDir);
  const mismatchedLog = readJson(join(runDir, "attempts", "02.json"));
  mismatchedLog.runId = "wrong-run";
  writeJson(join(runDir, "attempts", "02.json"), mismatchedLog);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-v10\/run\.json: promoted to schemaVersion 11/);
  const manifest = readJson(join(runDir, "run.json"));
  assert.equal(manifest.schemaVersion, 11);
  assert.equal(manifest.totalAttemptCount, 2);
  assert.equal(manifest.maxAttemptsPerSession, 3);
  assert.equal(manifest.totalSessionCount, 1);
  assert.equal(manifest.resetSeed.maxAttemptsPerSession, 3);
  assert.equal("attempts" in manifest, false);
  assert.equal("maxAttempts" in manifest, false);
  assert.equal("sessionCount" in manifest, false);
  assert.deepEqual(
    manifest.attemptRecords.map((record) => [
      record.attemptNumber,
      record.sessionIndex,
      record.attemptIndexInSession,
    ]),
    [
      [1, 0, 0],
      [2, 0, 1],
    ],
  );
  assert.equal(
    manifest.attemptRecords.some((record) => "tasksAfter" in record),
    false,
  );
  assert.equal(manifest.sessions[0].firstAttemptNumber, 1);
  assert.equal(manifest.sessions[0].lastAttemptNumber, 2);
  assert.equal(manifest.sessions[0].maxAttemptsPerSession, 3);
  assert.equal(manifest.hookAudits[0].attemptNumber, 1);
  assert.equal("attempt" in manifest.hookAudits[0], false);
  const log = readJson(join(runDir, "attempts", "02.json"));
  assert.equal(log.schemaVersion, 3);
  assert.equal(log.runId, "run-v10");
  assert.equal(log.attemptNumber, 2);
  assert.equal(log.attemptIndexInSession, 1);
  assert.equal("stdout" in log, false);
  assert.equal(log.stderr, "stderr-2");
});

test("migrate-manifests-v11 canonicalizes legacy hook audit attempt fields on v11 manifests", () => {
  const root = tempDir();
  const manifest = baseV10Manifest("run-v11");
  manifest.schemaVersion = 11;
  const runDir = writeManifest(root, "demo", "run-v11", manifest);
  writeAttemptLogs(runDir);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-v11\/run\.json: canonicalized schemaVersion 11/);
  const migrated = readJson(join(runDir, "run.json"));
  assert.equal(migrated.hookAudits[0].attemptNumber, 1);
  assert.equal("attempt" in migrated.hookAudits[0], false);
});

test("migrate-manifests-v11 reports malformed attempt logs and exits nonzero", () => {
  const root = tempDir();
  const runDir = writeManifest(root, "demo", "run-v10", baseV10Manifest());
  writeAttemptLogs(runDir);
  writeJson(join(runDir, "attempts", "02.json"), {
    schemaVersion: 1,
    runId: "run-v10",
    attempt: 99,
    sessionIndex: 0,
    startedAt: "2026-04-24T00:01:00.000Z",
    endedAt: "2026-04-24T00:02:00.000Z",
    stdout: "",
    stderr: "",
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-v10\/run\.json:/);
  assert.match(result.stdout, /attempt number does not match attempt record/);
});

test("migrate-manifests-v11 rejects attempt log paths that escape the workspace", () => {
  const root = tempDir();
  const manifest = baseV10Manifest();
  manifest.attemptRecords[0].logPath = "../outside.json";
  const runDir = writeManifest(root, "demo", "run-v10", manifest);
  writeAttemptLogs(runDir);

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-v10\/run\.json:/);
  assert.match(result.stdout, /\.\.\/outside\.json escapes workspace/);
});

test("migrate-manifests-v11 rejects malformed current session attempt numbers", () => {
  const root = tempDir();
  const manifest = baseV10Manifest();
  manifest.schemaVersion = 11;
  manifest.sessions[0].firstAttemptNumber = "bad";
  const runDir = writeManifest(root, "demo", "run-v11", manifest);
  writeAttemptLogs(runDir);

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-v11\/run\.json:/);
  assert.match(result.stdout, /sessions\[0\]\.firstAttemptNumber must be a number or null/);
});

test("migrate-manifests-v11 reports canonical v11 manifests as OK", () => {
  const root = tempDir();
  const runDir = writeManifest(root, "demo", "run-v10", baseV10Manifest());
  writeAttemptLogs(runDir);
  execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"]);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v10\/run\.json: already canonical schemaVersion 11/);
});

test("migrate-manifests-v11 honors repeated repo filters", () => {
  const root = tempDir();
  const selectedDir = writeManifest(root, "selected", "run-v10", baseV10Manifest());
  writeAttemptLogs(selectedDir);
  const skippedDir = writeManifest(root, "skipped", "run-v10", baseV10Manifest());
  writeAttemptLogs(skippedDir);

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "selected", "--write"]);

  assert.equal(readJson(join(selectedDir, "run.json")).schemaVersion, 11);
  assert.equal(readJson(join(skippedDir, "run.json")).schemaVersion, 10);
});
