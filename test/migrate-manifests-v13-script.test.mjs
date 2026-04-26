import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
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

function cleanupManifest() {
  return {
    schemaVersion: 12,
    runId: "run-cleanup",
    repo: "demo",
    transcript: "manifest transcript",
    sessions: [
      {
        sessionIndex: 0,
        startedAt: "2026-04-24T00:00:00.000Z",
        endedAt: "2026-04-24T00:02:00.000Z",
      },
    ],
    finalTasks: {
      t1: { id: "t1", title: "One", status: "completed", notes: "" },
    },
    resetSeed: {
      finalTasks: {
        t1: { id: "t1", title: "One", status: "pending", notes: "" },
      },
    },
    attachments: [{ id: "att-1", name: "artifact.txt" }],
    schedule: { enabled: true, runAt: "2026-04-24T00:00:00.000Z" },
    hookState: { custom: true },
    attemptRecords: [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
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
        tasksAfter: {
          t1: { id: "t1", title: "One", status: "pending", notes: "" },
        },
        invalidStatuses: [{ taskId: "t1", status: "waiting" }],
      },
      {
        attemptNumber: 2,
        sessionIndex: 0,
        attemptIndexInSession: 1,
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
        tasksAfter: null,
        invalidStatuses: [],
      },
      {
        attemptNumber: 3,
        sessionIndex: 0,
        attemptIndexInSession: 2,
        startedAt: "2026-04-24T00:02:00.000Z",
        endedAt: "2026-04-24T00:03:00.000Z",
        prompt: "already clean",
        sessionIdAtStart: "thread-1",
        sessionIdCaptured: "thread-1",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "clean",
        logPath: "attempts/03.json",
        invalidStatuses: [],
      },
    ],
  };
}

test("migrate-manifests-v13 dry-runs cleanup without writing", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-cleanup", cleanupManifest());
  const before = readFileSync(manifestPath, "utf8");

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(
    stdout,
    /DRY\s+runs\/demo\/run-cleanup\/run\.json: would remove tasksAfter from 2 attempt record\(s\), saving \d+ bytes/,
  );
  assert.match(
    stdout,
    /Summary: manifests cleaned=1 attempt records cleaned=2 bytes saved=\d+ errors=0/,
  );
  assert.equal(readFileSync(manifestPath, "utf8"), before);
});

test("migrate-manifests-v13 writes cleanup and preserves other fields", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-cleanup", cleanupManifest());
  const otherPath = writeManifest(root, "demo", "other-run", cleanupManifest());

  const stdout = execFileSync("node", [SCRIPT_PATH, "--file", manifestPath, "--write"], {
    encoding: "utf8",
  });

  assert.match(
    stdout,
    new RegExp(
      `WRITE\\s+${manifestPath}: removed tasksAfter from 2 attempt record\\(s\\), saved \\d+ bytes`,
    ),
  );
  assert.match(
    stdout,
    /Summary: manifests cleaned=1 attempt records cleaned=2 bytes saved=\d+ errors=0/,
  );
  const manifest = readJson(manifestPath);
  assert.equal(
    manifest.attemptRecords.some((record) => "tasksAfter" in record),
    false,
  );
  assert.equal(manifest.attemptRecords[0].transcript, "try");
  assert.equal(manifest.attemptRecords[0].logPath, "attempts/01.json");
  assert.deepEqual(manifest.attemptRecords[0].invalidStatuses, [
    { taskId: "t1", status: "waiting" },
  ]);
  assert.equal(manifest.attemptRecords[1].sessionIdAtStart, "thread-1");
  assert.equal(manifest.attemptRecords[1].sessionIdCaptured, "thread-1");
  assert.equal(manifest.attemptRecords[1].exitCode, 0);
  assert.equal(manifest.attemptRecords[1].signal, null);
  assert.equal(manifest.attemptRecords[1].timedOut, false);
  assert.deepEqual(manifest.sessions, cleanupManifest().sessions);
  assert.deepEqual(manifest.finalTasks, cleanupManifest().finalTasks);
  assert.deepEqual(manifest.resetSeed, cleanupManifest().resetSeed);
  assert.deepEqual(manifest.attachments, cleanupManifest().attachments);
  assert.deepEqual(manifest.schedule, cleanupManifest().schedule);
  assert.deepEqual(manifest.hookState, cleanupManifest().hookState);
  assert.equal(readFileSync(manifestPath, "utf8").endsWith("\n"), true);
  assert.equal(
    readJson(otherPath).attemptRecords.some((record) => "tasksAfter" in record),
    true,
  );

  const cleanedText = readFileSync(manifestPath, "utf8");
  const cleanedMtimeMs = statSync(manifestPath).mtimeMs;
  const rerunStdout = execFileSync("node", [SCRIPT_PATH, "--file", manifestPath, "--write"], {
    encoding: "utf8",
  });

  assert.match(rerunStdout, new RegExp(`OK\\s+${manifestPath}: no tasksAfter fields found`));
  assert.match(
    rerunStdout,
    /Summary: manifests cleaned=0 attempt records cleaned=0 bytes saved=0 errors=0/,
  );
  assert.equal(readFileSync(manifestPath, "utf8"), cleanedText);
  assert.equal(statSync(manifestPath).mtimeMs, cleanedMtimeMs);
});

test("migrate-manifests-v13 reports no-op manifests as OK", () => {
  const root = tempDir();
  writeManifest(root, "demo", "empty-attempts", { schemaVersion: 12, attemptRecords: [] });
  writeManifest(root, "demo", "missing-attempts", { schemaVersion: 12 });

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root], { encoding: "utf8" });

  assert.match(stdout, /OK\s+runs\/demo\/empty-attempts\/run\.json: no tasksAfter fields found/);
  assert.match(stdout, /OK\s+runs\/demo\/missing-attempts\/run\.json: no tasksAfter fields found/);
  assert.match(
    stdout,
    /Summary: manifests cleaned=0 attempt records cleaned=0 bytes saved=0 errors=0/,
  );
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
  assert.match(
    result.stdout,
    /Summary: manifests cleaned=0 attempt records cleaned=0 bytes saved=0 errors=2/,
  );
});

test("migrate-manifests-v13 rejects file and repo filters together", () => {
  const root = tempDir();
  const manifestPath = writeManifest(root, "demo", "run-cleanup", cleanupManifest());

  const result = spawnSync("node", [SCRIPT_PATH, "--file", manifestPath, "--repo", "demo"], {
    encoding: "utf8",
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /--file cannot be combined with --repo/);
  assert.match(result.stderr, /Usage: node scripts\/migrate-manifests-v13\.mjs/);
});
