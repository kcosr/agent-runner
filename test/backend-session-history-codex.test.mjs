import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  codexBackend,
  parseCodexSessionHistoryJsonl,
} from "../packages/core/dist/backends/codex.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-codex-history-"));
}

function writeJsonl(path, records) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

const CODEX_SESSION_ID = "019de655-7446-7952-b343-dbcb507cf74a";
const CODEX_SESSION_PATH_PARTS = [
  ".codex",
  "sessions",
  "2026",
  "05",
  "02",
  `rollout-2026-05-02T01-37-33-${CODEX_SESSION_ID}.jsonl`,
];
const CODEX_LOCAL_SESSION_PATH_PARTS = [
  ".codex",
  "sessions",
  "2026",
  "05",
  "01",
  `rollout-2026-05-01T20-37-33-${CODEX_SESSION_ID}.jsonl`,
];

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
        content: [{ type: "input_text", text: "Injected context should be ignored" }],
      },
    },
    {
      timestamp: "2026-05-01T00:00:02.100Z",
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Question A",
      },
    },
    {
      timestamp: "2026-05-01T00:00:02.200Z",
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
        role: "user",
        content: [
          {
            type: "input_text",
            text: "<subagent_notification>internal status</subagent_notification>",
          },
        ],
      },
    },
    {
      timestamp: "2026-05-01T00:00:04.100Z",
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
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Unfinished",
      },
    },
    {
      timestamp: "2026-05-01T00:00:07.100Z",
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Unfinished" }],
      },
    },
  ];
}

test("codex history parser returns complete turns in source order and joins assistant messages", async () => {
  const dir = tempDir();
  const path = join(dir, "rollout-test.jsonl");
  writeJsonl(path, sessionRecords());

  const turns = await parseCodexSessionHistoryJsonl(path);

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

test("codex history resolves rollout file by deterministic session filename", async () => {
  const home = tempDir();
  const path = join(home, ...CODEX_SESSION_PATH_PARTS);
  writeJsonl(path, sessionRecords(CODEX_SESSION_ID));

  await withEnv({ HOME: home, TZ: "UTC" }, async () => {
    const resolved = await codexBackend.resolveSessionHistorySource({
      sessionId: CODEX_SESSION_ID,
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, true);
    assert.equal(resolved.source.kind, "file");
    assert.equal(resolved.source.path, path);

    const result = await codexBackend.readSessionHistory({
      sessionId: CODEX_SESSION_ID,
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

test("codex history resolves rollout file by local timestamp filename", async () => {
  const home = tempDir();
  const path = join(home, ...CODEX_LOCAL_SESSION_PATH_PARTS);
  writeJsonl(path, sessionRecords(CODEX_SESSION_ID));

  await withEnv({ HOME: home, TZ: "America/Chicago" }, async () => {
    const resolved = await codexBackend.resolveSessionHistorySource({
      sessionId: CODEX_SESSION_ID,
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, true);
    assert.equal(resolved.source.path, path);
  });
});

test("codex history parser reports malformed jsonl with file and line", async () => {
  const dir = tempDir();
  const path = join(dir, "rollout-bad.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(sessionRecords()[0])}\n{not-json}\n`);

  await assert.rejects(
    () => parseCodexSessionHistoryJsonl(path),
    /failed to parse Codex session history rollout-bad\.jsonl:2: invalid JSON/,
  );
});

test("codex history rejects matching rollout symlinks that escape the sessions root", async () => {
  const home = tempDir();
  const linkPath = join(home, ...CODEX_SESSION_PATH_PARTS);
  const outsidePath = join(home, "outside.jsonl");
  writeJsonl(outsidePath, sessionRecords(CODEX_SESSION_ID));
  mkdirSync(join(linkPath, ".."), { recursive: true });
  symlinkSync(outsidePath, linkPath);

  await withEnv({ HOME: home, TZ: "UTC" }, async () => {
    const resolved = await codexBackend.resolveSessionHistorySource({
      sessionId: CODEX_SESSION_ID,
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, false);
  });
});

test("codex history does not parse unrelated rollout files while resolving a matching session", async () => {
  const home = tempDir();
  const corruptPath = join(home, ".codex", "sessions", "2026", "04", "30", "rollout-corrupt.jsonl");
  const targetPath = join(home, ...CODEX_SESSION_PATH_PARTS);
  mkdirSync(join(corruptPath, ".."), { recursive: true });
  writeFileSync(corruptPath, "{not-json}\n");
  writeJsonl(targetPath, sessionRecords(CODEX_SESSION_ID));

  await withEnv({ HOME: home, TZ: "UTC" }, async () => {
    const resolved = await codexBackend.resolveSessionHistorySource({
      sessionId: CODEX_SESSION_ID,
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, true);
    assert.equal(resolved.source.path, targetPath);
  });
});

test("codex history source is unavailable when no rollout matches the thread id", async () => {
  const home = tempDir();
  const missingSessionId = "019de656-7446-7952-b343-dbcb507cf74b";
  const path = join(home, ...CODEX_SESSION_PATH_PARTS);
  writeJsonl(path, sessionRecords("other-thread"));

  await withEnv({ HOME: home, TZ: "UTC" }, async () => {
    const resolved = await codexBackend.resolveSessionHistorySource({
      sessionId: missingSessionId,
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, false);
    assert.match(
      resolved.reason,
      /codex session "019de656-7446-7952-b343-dbcb507cf74b" not found at expected rollout paths under .*\.codex\/sessions/,
    );
  });
});
