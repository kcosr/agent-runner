import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  codexBackend,
  parseCodexSessionHistoryJsonl,
} from "../packages/core/dist/backends/codex.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-codex-history-"));
}

function writeJsonl(path, records) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function sessionRecords(sessionId = "thread-123") {
  return [
    {
      timestamp: "2026-05-01T00:00:00.000Z",
      type: "session_meta",
      payload: { id: sessionId, cwd: "/repo" },
    },
    {
      timestamp: "2026-05-01T00:00:01.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-a" },
    },
    {
      timestamp: "2026-05-01T00:00:02.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Question A" }],
      },
    },
    {
      timestamp: "2026-05-01T00:00:03.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer one." }],
      },
    },
    {
      timestamp: "2026-05-01T00:00:04.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Answer two." }],
      },
    },
    {
      timestamp: "2026-05-01T00:00:05.000Z",
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-a" },
    },
    {
      timestamp: "2026-05-01T00:00:06.000Z",
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-open" },
    },
    {
      timestamp: "2026-05-01T00:00:07.000Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Unfinished" }],
      },
    },
  ];
}

test("codex history parser returns complete turns in source order and joins assistant messages", () => {
  const dir = tempDir();
  const path = join(dir, "rollout-test.jsonl");
  writeJsonl(path, sessionRecords());

  const turns = parseCodexSessionHistoryJsonl(path);

  assert.deepEqual(turns, [
    {
      backendTurnId: "turn-a",
      status: "complete",
      startedAt: "2026-05-01T00:00:01.000Z",
      updatedAt: "2026-05-01T00:00:05.000Z",
      userText: "Question A",
      assistantText: "Answer one.\n\nAnswer two.",
    },
  ]);
});

test("codex history resolves rollout file by session_meta payload id", async () => {
  const home = tempDir();
  const path = join(
    home,
    ".codex",
    "sessions",
    "2026",
    "05",
    "01",
    "rollout-2026-05-01T00-00-00-thread-123.jsonl",
  );
  writeJsonl(path, sessionRecords("thread-123"));

  await withEnv({ HOME: home }, async () => {
    const resolved = await codexBackend.resolveSessionHistorySource({
      sessionId: "thread-123",
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, true);
    assert.equal(resolved.source.kind, "file");
    assert.equal(resolved.source.path, path);

    const result = await codexBackend.readSessionHistory({
      sessionId: "thread-123",
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
      source: resolved.source,
      mode: "bootstrap",
    });
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].backendTurnId, "turn-a");
  });
});

test("codex history parser reports malformed jsonl with file and line", () => {
  const dir = tempDir();
  const path = join(dir, "rollout-bad.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(sessionRecords()[0])}\n{not-json}\n`);

  assert.throws(
    () => parseCodexSessionHistoryJsonl(path),
    new RegExp(`failed to parse Codex session history ${path}:2`),
  );
});

test("codex history source is unavailable when no rollout matches the thread id", async () => {
  const home = tempDir();
  const path = join(home, ".codex", "sessions", "2026", "05", "01", "rollout-other.jsonl");
  writeJsonl(path, sessionRecords("other-thread"));

  await withEnv({ HOME: home }, async () => {
    const resolved = await codexBackend.resolveSessionHistorySource({
      sessionId: "missing-thread",
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, false);
    assert.match(
      resolved.reason,
      /codex session "missing-thread" not found under .*\.codex\/sessions/,
    );
  });
});
