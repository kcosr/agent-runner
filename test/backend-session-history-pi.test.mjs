import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  encodePiSessionDir,
  parsePiSessionHistoryJsonl,
  piBackend,
} from "../packages/core/dist/backends/pi.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-pi-history-"));
}

function writeJsonl(path, records) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function sessionRecords(cwd = "/repo") {
  return [
    {
      type: "session",
      id: "pi-session-1",
      timestamp: "2026-05-01T00:00:00.000Z",
      cwd,
    },
    {
      type: "message",
      id: "user-a",
      timestamp: "2026-05-01T00:00:01.000Z",
      message: { role: "user", content: "Question A" },
    },
    {
      type: "message",
      timestamp: "2026-05-01T00:00:02.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", text: "private chain of thought" },
          { type: "text", text: "Answer A" },
          { type: "tool_use", name: "ignored", text: "tool-only content" },
        ],
      },
    },
    {
      type: "message",
      timestamp: "2026-05-01T00:00:03.000Z",
      message: { role: "user", content: [{ type: "text", text: "Dropped no-answer" }] },
    },
    {
      type: "message",
      timestamp: "2026-05-01T00:00:04.000Z",
      message: { role: "user", content: [{ type: "text", text: "Question B" }] },
    },
    {
      type: "message",
      timestamp: "2026-05-01T00:00:05.000Z",
      message: { role: "assistant", content: "Answer B one." },
    },
    {
      type: "message",
      timestamp: "2026-05-01T00:00:06.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Answer B two." }] },
    },
  ];
}

test("pi history parser returns complete turns and drops historical no-answer turns", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-session.jsonl");
  writeJsonl(path, sessionRecords());

  const turns = await parsePiSessionHistoryJsonl({
    path,
    sessionId: "pi-session-1",
    mode: "bootstrap",
  });

  assert.deepEqual(
    turns.map((turn) => ({
      backendTurnId: turn.backendTurnId,
      status: turn.status,
      startedAt: turn.startedAt,
      updatedAt: turn.updatedAt,
      userText: turn.userText,
      assistantText: turn.assistantText,
    })),
    [
      {
        backendTurnId: "user-a",
        status: "complete",
        startedAt: "2026-05-01T00:00:01.000Z",
        updatedAt: "2026-05-01T00:00:02.000Z",
        userText: "Question A",
        assistantText: "Answer A",
      },
      {
        backendTurnId: "pi:pi-session-1:line:4",
        status: "complete",
        startedAt: "2026-05-01T00:00:04.000Z",
        updatedAt: "2026-05-01T00:00:06.000Z",
        userText: "Question B",
        assistantText: "Answer B one.\n\nAnswer B two.",
      },
    ],
  );
});

test("pi history parser keeps the latest no-answer sync turn open", async () => {
  const dir = tempDir();
  const path = join(dir, "pi-session.jsonl");
  writeJsonl(path, [
    ...sessionRecords().slice(0, 3),
    {
      type: "message",
      id: "user-open",
      timestamp: "2026-05-01T00:00:03.000Z",
      message: { role: "user", content: "Still pending" },
    },
  ]);

  const turns = await parsePiSessionHistoryJsonl({
    path,
    sessionId: "pi-session-1",
    mode: "sync",
  });

  assert.equal(turns.length, 2);
  assert.equal(turns[0].status, "complete");
  assert.deepEqual(turns[1], {
    backendTurnId: "user-open",
    status: "open",
    startedAt: "2026-05-01T00:00:03.000Z",
    updatedAt: "2026-05-01T00:00:03.000Z",
    userText: "Still pending",
    assistantText: null,
  });
});

test("pi history resolves and reads the cwd-bound PI_HOME session file", async () => {
  const home = tempDir();
  const cwd = "/repo";
  const bucketDir = join(home, "agent", "sessions", encodePiSessionDir(cwd));
  writeJsonl(join(bucketDir, "2026-04-30T00-00-00-000Z_other-session.jsonl"), sessionRecords(cwd));
  writeJsonl(join(bucketDir, "unrelated.jsonl"), sessionRecords(cwd));
  const path = join(bucketDir, "2026-05-01T00-00-00-000Z_pi-session-1.jsonl");
  writeJsonl(path, sessionRecords(cwd));

  await withEnv({ PI_HOME: home }, async () => {
    const resolved = await piBackend.resolveSessionHistorySource({
      sessionId: "pi-session-1",
      cwd,
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, true);
    assert.equal(resolved.source.kind, "file");
    assert.equal(resolved.source.path, path);

    const result = await piBackend.readSessionHistory({
      sessionId: "pi-session-1",
      cwd,
      env: {},
      resolvedBackendArgs: [],
      source: resolved.source,
      mode: "bootstrap",
    });
    assert.deepEqual(result.cursor, { kind: "file", size: resolved.source.size });
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].backendTurnId, "user-a");
  });
});

test("pi history source is unavailable for cwd mismatch and source escape", async () => {
  const home = tempDir();
  const cwd = "/repo";
  const bucketDir = join(home, "agent", "sessions", encodePiSessionDir(cwd));
  const mismatchPath = join(bucketDir, "2026-05-01T00-00-00-000Z_pi-mismatch.jsonl");
  writeJsonl(mismatchPath, sessionRecords("/other"));

  const outsidePath = join(home, "outside.jsonl");
  writeJsonl(outsidePath, sessionRecords(cwd));
  symlinkSync(outsidePath, join(bucketDir, "2026-05-01T00-00-00-000Z_pi-escape.jsonl"));

  await withEnv({ PI_HOME: home }, async () => {
    const mismatch = await piBackend.resolveSessionHistorySource({
      sessionId: "pi-mismatch",
      cwd,
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(mismatch.available, false);
    assert.match(mismatch.reason, /belongs to cwd "\/other"/);

    const escaped = await piBackend.resolveSessionHistorySource({
      sessionId: "pi-escape",
      cwd,
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(escaped.available, false);
    assert.equal(escaped.reason, "pi session file escaped the cwd bucket");
  });
});

test("pi history parser reports malformed jsonl with file and line", async () => {
  const dir = tempDir();
  const path = join(dir, "session-bad.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(sessionRecords()[0])}\n{not-json}\n`);

  await assert.rejects(
    () =>
      parsePiSessionHistoryJsonl({
        path,
        sessionId: "pi-session-1",
        mode: "bootstrap",
      }),
    /failed to parse Pi session history session-bad\.jsonl:2: invalid JSON/,
  );
});

test("pi history parser skips malformed trailing partial lines", async () => {
  const dir = tempDir();
  const path = join(dir, "session-partial.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    path,
    `${JSON.stringify(sessionRecords()[0])}\n${JSON.stringify({
      type: "message",
      timestamp: "2026-05-01T00:00:01.000Z",
      message: { role: "user", content: "Question" },
    })}\n{not-json`,
  );

  assert.deepEqual(
    await parsePiSessionHistoryJsonl({
      path,
      sessionId: "pi-session-1",
      mode: "sync",
    }),
    [
      {
        backendTurnId: "pi:pi-session-1:line:1",
        status: "open",
        startedAt: "2026-05-01T00:00:01.000Z",
        updatedAt: "2026-05-01T00:00:01.000Z",
        userText: "Question",
        assistantText: null,
      },
    ],
  );
});

test("pi history parser rejects empty or non-session histories", async () => {
  const dir = tempDir();
  const emptyPath = join(dir, "empty.jsonl");
  const nonSessionPath = join(dir, "non-session.jsonl");
  writeFileSync(emptyPath, "");
  writeJsonl(nonSessionPath, [{ type: "message", message: { role: "user", content: "Q" } }]);

  await assert.rejects(
    () => parsePiSessionHistoryJsonl({ path: emptyPath, sessionId: "pi-session-1", mode: "sync" }),
    /Pi session history is empty/,
  );
  await assert.rejects(
    () =>
      parsePiSessionHistoryJsonl({
        path: nonSessionPath,
        sessionId: "pi-session-1",
        mode: "sync",
      }),
    /first record must have type "session"/,
  );
});
