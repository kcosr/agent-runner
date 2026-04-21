import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-run-events-v2.mjs", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-migrate-run-events-v2-"));
}

function writeRunEvents(root, repo, runId, lines) {
  const dir = join(root, "runs", repo, runId);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "run-events.jsonl");
  writeFileSync(path, lines.join("\n"));
  return path;
}

function readRunEvents(path) {
  const raw = readFileSync(path, "utf8").trim();
  if (raw.length === 0) {
    return [];
  }
  return raw.split("\n").map((line) => JSON.parse(line));
}

test("migrate-run-events-v2 script dry-runs mixed legacy rows, skips malformed lines, and honors repo filters", () => {
  const root = tempDir();
  const selectedPath = writeRunEvents(root, "task-runner", "run-1", [
    JSON.stringify({
      schemaVersion: 1,
      recordedAt: "2026-04-21T12:41:02.000Z",
      runId: "run-1",
      eventType: "run.created",
      source: "daemon",
      hostMode: "daemon",
      backend: "codex",
    }),
    "{bad-json",
    JSON.stringify({
      schemaVersion: 2,
      recordedAt: "2026-04-21T12:41:03.000Z",
      cursor: 99,
      runId: "run-1",
      eventType: "run.started",
      source: "daemon",
      hostMode: "daemon",
      sessionIndex: 0,
    }),
  ]);
  const skippedPath = writeRunEvents(root, "assistant", "run-2", [
    JSON.stringify({
      schemaVersion: 1,
      recordedAt: "2026-04-21T12:41:04.000Z",
      runId: "run-2",
      eventType: "run.created",
      source: "cli",
      hostMode: "embedded",
    }),
  ]);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--repo", "task-runner"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(
    stdout,
    /DRY\s+.*run-1\/run-events\.jsonl: would canonicalize 2 rows to schemaVersion 2; skipped 1 malformed/,
  );
  assert.match(stdout, /SKIP\s+.*run-2\/run-events\.jsonl: repo bucket assistant not selected/);
  assert.equal(
    readFileSync(selectedPath, "utf8"),
    [
      JSON.stringify({
        schemaVersion: 1,
        recordedAt: "2026-04-21T12:41:02.000Z",
        runId: "run-1",
        eventType: "run.created",
        source: "daemon",
        hostMode: "daemon",
        backend: "codex",
      }),
      "{bad-json",
      JSON.stringify({
        schemaVersion: 2,
        recordedAt: "2026-04-21T12:41:03.000Z",
        cursor: 99,
        runId: "run-1",
        eventType: "run.started",
        source: "daemon",
        hostMode: "daemon",
        sessionIndex: 0,
      }),
    ].join("\n"),
  );
  assert.equal(
    readFileSync(skippedPath, "utf8"),
    JSON.stringify({
      schemaVersion: 1,
      recordedAt: "2026-04-21T12:41:04.000Z",
      runId: "run-2",
      eventType: "run.created",
      source: "cli",
      hostMode: "embedded",
    }),
  );
});

test("migrate-run-events-v2 script writes legacy rows as canonical schemaVersion 2 with monotonic cursors", () => {
  const root = tempDir();
  const runEventsPath = writeRunEvents(root, "task-runner", "run-1", [
    JSON.stringify({
      schemaVersion: 1,
      recordedAt: "2026-04-21T12:41:02.000Z",
      runId: "run-1",
      eventType: "run.created",
      source: "daemon",
      hostMode: "daemon",
      backend: "codex",
      name: "Run audit",
    }),
    JSON.stringify({
      schemaVersion: 1,
      recordedAt: "2026-04-21T12:41:03.000Z",
      runId: "run-1",
      eventType: "task.updated",
      source: "task_command",
      hostMode: "embedded",
      taskId: "implement_core",
      notesChanged: true,
    }),
  ]);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(
    stdout,
    /WRITE\s+.*run-1\/run-events\.jsonl: canonicalized 2 rows to schemaVersion 2/,
  );
  assert.deepEqual(readRunEvents(runEventsPath), [
    {
      schemaVersion: 2,
      recordedAt: "2026-04-21T12:41:02.000Z",
      cursor: 1,
      runId: "run-1",
      eventType: "run.created",
      source: "daemon",
      hostMode: "daemon",
      backend: "codex",
      name: "Run audit",
    },
    {
      schemaVersion: 2,
      recordedAt: "2026-04-21T12:41:03.000Z",
      cursor: 2,
      runId: "run-1",
      eventType: "task.updated",
      source: "task_command",
      hostMode: "embedded",
      taskId: "implement_core",
      notesChanged: true,
    },
  ]);
});

test("migrate-run-events-v2 script reports canonical schemaVersion 2 files as no-op", () => {
  const root = tempDir();
  const runEventsPath = writeRunEvents(root, "task-runner", "run-1", [
    JSON.stringify({
      schemaVersion: 2,
      recordedAt: "2026-04-21T12:41:02.000Z",
      cursor: 1,
      runId: "run-1",
      eventType: "run.created",
      source: "daemon",
      hostMode: "daemon",
    }),
    JSON.stringify({
      schemaVersion: 2,
      recordedAt: "2026-04-21T12:41:03.000Z",
      cursor: 2,
      runId: "run-1",
      eventType: "run.started",
      source: "daemon",
      hostMode: "daemon",
      sessionIndex: 0,
    }),
  ]);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--root", root, "--write"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });

  assert.match(
    stdout,
    /OK\s+.*run-1\/run-events\.jsonl: already canonical schemaVersion 2 audit rows/,
  );
  assert.deepEqual(readRunEvents(runEventsPath), [
    {
      schemaVersion: 2,
      recordedAt: "2026-04-21T12:41:02.000Z",
      cursor: 1,
      runId: "run-1",
      eventType: "run.created",
      source: "daemon",
      hostMode: "daemon",
    },
    {
      schemaVersion: 2,
      recordedAt: "2026-04-21T12:41:03.000Z",
      cursor: 2,
      runId: "run-1",
      eventType: "run.started",
      source: "daemon",
      hostMode: "daemon",
      sessionIndex: 0,
    },
  ]);
});
