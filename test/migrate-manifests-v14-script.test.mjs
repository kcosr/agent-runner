import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-manifests-v14.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-migrate-v14-"));
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
  const next = {
    ...manifest,
    runId,
    repo,
    workspaceDir: dir,
  };
  writeJson(manifestPath, next);
  return manifestPath;
}

function baseV13Manifest(runId = "run-v13") {
  return {
    schemaVersion: 13,
    runId,
    repo: "demo",
    agent: { name: "agent", sourcePath: null, instructions: "work" },
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    backendSpecific: { codex: { transport: { type: "stdio" } } },
    resolvedBackendArgs: ["--flag"],
    launcher: { kind: "direct", name: "direct" },
    message: null,
    name: "Kept run name",
    note: "Kept note",
    pinned: true,
    unrestricted: false,
    cwd: "/repo",
    lockedFields: ["model"],
    timeoutSec: 10,
    workspaceDir: "/state/run",
    assignmentPath: "/state/run/assignment-seed.md",
    startedAt: "2026-04-24T00:00:00.000Z",
    endedAt: null,
    archivedAt: null,
    status: "ready",
    dependencyRunIds: ["dep-a"],
    parentRunId: "parent-a",
    schedule: {
      enabled: true,
      runAt: "2026-05-01T00:00:00.000Z",
      recurrence: null,
    },
    exitCode: null,
    totalAttemptCount: 1,
    maxAttemptsPerSession: 3,
    tasksCompleted: 0,
    tasksTotal: 1,
    backendSessionId: "session-a",
    runtimeVars: { range: "main..HEAD" },
    runtimeVarSources: { range: { source: "cli" } },
    execution: { hostMode: "embedded", controller: { kind: "embedded" } },
    brief: "brief",
    resolvedHooks: [],
    hookState: { prepared: true },
    hookAudits: [],
    callerInstructions: "caller docs",
    resetSeed: {
      backend: "claude",
      model: null,
      effort: null,
      backendSpecific: { codex: { transport: { type: "stdio" } } },
      resolvedBackendArgs: ["--flag"],
      launcher: { kind: "direct", name: "direct" },
      cwd: "/repo",
      lockedFields: ["model"],
      message: null,
      name: "Kept run name",
      note: "Kept note",
      pinned: true,
      dependencyRunIds: ["dep-a"],
      parentRunId: "parent-a",
      unrestricted: false,
      timeoutSec: 10,
      maxAttemptsPerSession: 3,
      brief: "brief",
      runtimeVars: { range: "main..HEAD" },
      runtimeVarSources: { range: { source: "cli" } },
      hookState: { prepared: true },
      attachments: [
        {
          id: "att-a",
          name: "a.txt",
          mimeType: "text/plain",
          size: 1,
          sha256: "abc",
          addedAt: "2026-04-24T00:00:00.000Z",
          relativePath: "attachments/att-a/a.txt",
        },
      ],
      finalTasks: {
        t1: { id: "t1", title: "One", body: "Body", status: "pending", notes: "Notes" },
      },
    },
    attachments: [
      {
        id: "att-a",
        name: "a.txt",
        mimeType: "text/plain",
        size: 1,
        sha256: "abc",
        addedAt: "2026-04-24T00:00:00.000Z",
        relativePath: "attachments/att-a/a.txt",
      },
    ],
    finalTasks: {
      t1: { id: "t1", title: "One", body: "Body", status: "pending", notes: "Notes" },
    },
    totalSessionCount: 1,
    sessions: [
      {
        sessionIndex: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: null,
        status: "ready",
        exitCode: null,
        message: null,
        brief: "brief",
        firstAttemptNumber: 1,
        lastAttemptNumber: 1,
        maxAttemptsPerSession: 3,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "session-a",
      },
    ],
    attemptRecords: [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:01:00.000Z",
        prompt: "brief",
        sessionIdAtStart: null,
        sessionIdCaptured: "session-a",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: null,
        logPath: "attempts/01.json",
        invalidStatuses: [],
      },
    ],
  };
}

function assignmentBackedManifest(runId = "run-v13") {
  const manifest = baseV13Manifest(runId);
  manifest.assignment = {
    name: "demo-assignment",
    sourcePath: "/repo/assignments/demo/assignment.md",
    workspacePath: "/state/run/assignment-seed.md",
  };
  return manifest;
}

test("migrate-manifests-v14 dry-runs v13 promotion without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v13", assignmentBackedManifest());

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /DRY\s+runs\/demo\/run-v13\/run\.json: would promote to schemaVersion 14/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 13);
  assert.equal(typeof manifest.assignmentPath, "string");
  assert.equal(typeof manifest.assignment.workspacePath, "string");
});

test("migrate-manifests-v14 writes assignment-backed v13 manifests", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v13", assignmentBackedManifest());
  const before = readJson(manifestPath);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-v13\/run\.json: promoted to schemaVersion 14/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 14);
  assert.equal("assignmentPath" in manifest, false);
  assert.deepEqual(manifest.assignment, {
    name: "demo-assignment",
    sourcePath: "/repo/assignments/demo/assignment.md",
  });
  assert.deepEqual(manifest.schedule, before.schedule);
  assert.deepEqual(manifest.resetSeed, before.resetSeed);
  assert.deepEqual(manifest.attachments, before.attachments);
  assert.deepEqual(manifest.sessions, before.sessions);
  assert.deepEqual(manifest.attemptRecords, before.attemptRecords);
  assert.deepEqual(manifest.runtimeVars, before.runtimeVars);
  assert.deepEqual(manifest.finalTasks, before.finalTasks);
});

test("migrate-manifests-v14 preserves assignment null", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v13", baseV13Manifest());
  const before = readJson(manifestPath);

  execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], { encoding: "utf8" });

  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 14);
  assert.equal("assignmentPath" in manifest, false);
  assert.equal(manifest.assignment, null);
  assert.deepEqual(manifest.schedule, before.schedule);
  assert.deepEqual(manifest.resetSeed, before.resetSeed);
  assert.deepEqual(manifest.attachments, before.attachments);
  assert.deepEqual(manifest.sessions, before.sessions);
  assert.deepEqual(manifest.attemptRecords, before.attemptRecords);
  assert.deepEqual(manifest.runtimeVars, before.runtimeVars);
  assert.deepEqual(manifest.finalTasks, before.finalTasks);
});

test("migrate-manifests-v14 can target repeated repo filters", () => {
  const root = tempDir();
  const repoA = writeManifest(root, "repo-a", "run-a", assignmentBackedManifest("run-a"));
  const repoB = writeManifest(root, "repo-b", "run-b", assignmentBackedManifest("run-b"));
  const skipped = writeManifest(root, "repo-c", "run-c", assignmentBackedManifest("run-c"));

  const stdout = execFileSync(
    "node",
    [SCRIPT_PATH, "--root", root, "--repo", "repo-a", "--repo", "repo-b", "--write"],
    { encoding: "utf8" },
  );

  assert.match(stdout, /WRITE\s+runs\/repo-a\/run-a\/run\.json: promoted to schemaVersion 14/);
  assert.match(stdout, /WRITE\s+runs\/repo-b\/run-b\/run\.json: promoted to schemaVersion 14/);
  assert.equal(readJson(repoA).schemaVersion, 14);
  assert.equal(readJson(repoB).schemaVersion, 14);
  assert.equal(readJson(skipped).schemaVersion, 13);
});

test("migrate-manifests-v14 can target repeated manifest files", () => {
  const root = tempDir();
  const first = writeManifest(root, "demo", "run-a", assignmentBackedManifest("run-a"));
  const second = writeManifest(root, "demo", "run-b", assignmentBackedManifest("run-b"));
  const skipped = writeManifest(root, "demo", "run-c", assignmentBackedManifest("run-c"));

  const stdout = execFileSync("node", [SCRIPT_PATH, "--file", first, "--file", second, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, new RegExp(`WRITE\\s+${first}: promoted to schemaVersion 14`));
  assert.match(stdout, new RegExp(`WRITE\\s+${second}: promoted to schemaVersion 14`));
  assert.equal(readJson(first).schemaVersion, 14);
  assert.equal(readJson(second).schemaVersion, 14);
  assert.equal(readJson(skipped).schemaVersion, 13);
});

test("migrate-manifests-v14 reports canonical v14 manifests as OK", () => {
  const root = tempDir();
  const {
    assignmentPath: _assignmentPath,
    assignment,
    ...canonical
  } = assignmentBackedManifest("run-v14");
  canonical.schemaVersion = 14;
  canonical.assignment = {
    name: assignment.name,
    sourcePath: assignment.sourcePath,
  };
  writeManifest(root, "demo", "run-v14", canonical);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/run-v14\/run\.json: already canonical schemaVersion 14/);
});

test("migrate-manifests-v14 skips run directories without manifests", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-v13", assignmentBackedManifest());
  mkdirSync(join(root, "runs", "demo", "missing-manifest"), { recursive: true });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.match(stdout, /WRITE\s+runs\/demo\/run-v13\/run\.json: promoted to schemaVersion 14/);
  assert.doesNotMatch(stdout, /missing-manifest/);
});

test("migrate-manifests-v14 rejects running v13 manifests without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-running", {
    ...assignmentBackedManifest("run-running"),
    status: "running",
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-running\/run\.json:/);
  assert.match(result.stdout, /schemaVersion 13 manifest is running/);
  const manifest = readJson(manifestPath);
  assert.equal(manifest.schemaVersion, 13);
  assert.equal(manifest.status, "running");
  assert.equal("assignmentPath" in manifest, true);
});

test("migrate-manifests-v14 rejects v14 manifests carrying legacy path fields", () => {
  const root = tempDir();
  const stale = assignmentBackedManifest("run-v14-stale");
  stale.schemaVersion = 14;
  writeManifest(root, "demo", "run-v14-stale", stale);

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-v14-stale\/run\.json:/);
  assert.match(
    result.stdout,
    /schemaVersion 14 manifest still contains legacy assignment seed path fields/,
  );
});

test("migrate-manifests-v14 rejects workspacePath-only stale v14 manifests", () => {
  const root = tempDir();
  const { assignmentPath: _assignmentPath, ...stale } =
    assignmentBackedManifest("run-v14-workspace-only");
  stale.schemaVersion = 14;
  writeManifest(root, "demo", "run-v14-workspace-only", stale);

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-v14-workspace-only\/run\.json:/);
  assert.match(
    result.stdout,
    /schemaVersion 14 manifest still contains legacy assignment seed path fields/,
  );
});

test("migrate-manifests-v14 rejects malformed manifest JSON", () => {
  const root = tempDir();
  const runDir = join(root, "runs", "demo", "bad-json");
  mkdirSync(runDir, { recursive: true });
  writeFileSync(join(runDir, "run.json"), "{bad");

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/bad-json\/run\.json: invalid JSON:/);
});

test("migrate-manifests-v14 reports a missing runs root", () => {
  const root = join(tempDir(), "missing-state");

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    new RegExp(`runs root ${root}/runs does not exist or cannot be read`),
  );
});

test("migrate-manifests-v14 rejects unsupported versions", () => {
  const root = tempDir();
  writeManifest(root, "demo", "run-v12", {
    ...assignmentBackedManifest("run-v12"),
    schemaVersion: 12,
  });

  const result = spawnSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.equal(result.status, 1);
  assert.match(result.stdout, /ERROR\s+runs\/demo\/run-v12\/run\.json:/);
  assert.match(result.stdout, /unsupported schemaVersion 12; migrate to schemaVersion 13 first/);
});

test("migrate-manifests-v14 rejects file and repo filters together", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-v13", assignmentBackedManifest());

  const result = spawnSync("node", [SCRIPT_PATH, "--file", manifestPath, "--repo", "demo"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--file cannot be combined with --repo/);
  assert.match(result.stderr, /Usage: node scripts\/migrate-manifests-v14\.mjs/);
});
