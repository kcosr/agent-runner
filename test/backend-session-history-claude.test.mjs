import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeBackend,
  claudeSessionFilePath,
  parseClaudeSessionHistoryJsonl,
} from "../packages/core/dist/backends/claude.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-claude-history-"));
}

function writeJsonl(path, records) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

function records() {
  return [
    {
      timestamp: "2026-05-01T00:00:00.000Z",
      type: "user",
      uuid: "user-stable-id",
      message: { role: "user", content: "Question A" },
    },
    {
      timestamp: "2026-05-01T00:00:01.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Answer A" }],
        stop_reason: "end_turn",
      },
    },
    {
      timestamp: "2026-05-01T00:00:02.000Z",
      type: "user",
      message: {
        role: "user",
        content: [{ type: "text", text: "<task-notification>internal</task-notification>" }],
      },
    },
    {
      timestamp: "2026-05-01T00:00:03.000Z",
      type: "assistant",
      isSidechain: true,
      message: { role: "assistant", content: [{ type: "text", text: "sidechain ignored" }] },
    },
    {
      timestamp: "2026-05-01T00:00:04.000Z",
      type: "user",
      message: { role: "user", content: [{ type: "tool_result", content: "tool only" }] },
    },
    {
      timestamp: "2026-05-01T00:00:05.000Z",
      type: "user",
      message: { role: "user", content: [{ type: "text", text: "Question B" }] },
    },
    {
      timestamp: "2026-05-01T00:00:06.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "Answer B one." },
          { type: "tool_use", name: "ignored" },
        ],
        stop_reason: "max_tokens",
      },
    },
    {
      timestamp: "2026-05-01T00:00:07.000Z",
      type: "assistant",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "Answer B two." }],
        stop_reason: "stop_sequence",
      },
    },
  ];
}

test("claude history parser ignores sidechains, task notifications, tool-only users, and terminal markers", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, records());

  const turns = await parseClaudeSessionHistoryJsonl({
    path,
    sessionId: "session-123",
    mode: "bootstrap",
  });

  assert.deepEqual(
    turns.map((turn) => ({
      backendTurnId: turn.backendTurnId,
      status: turn.status,
      userText: turn.userText,
      assistantText: turn.assistantText,
    })),
    [
      {
        backendTurnId: "user-stable-id",
        status: "complete",
        userText: "Question A",
        assistantText: "Answer A",
      },
      {
        backendTurnId: "claude:session-123:line:5",
        status: "complete",
        userText: "Question B",
        assistantText: "Answer B one.\n\nAnswer B two.",
      },
    ],
  );
});

test("claude history parser treats latest sync turn as mutable open", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, records());

  const turns = await parseClaudeSessionHistoryJsonl({
    path,
    sessionId: "session-123",
    mode: "sync",
  });

  assert.equal(turns[0].status, "complete");
  assert.equal(turns[1].backendTurnId, "claude:session-123:line:5");
  assert.equal(turns[1].status, "open");
});

test("claude history parser completes latest sync turn after terminal marker", async () => {
  const dir = tempDir();
  const path = join(dir, "session.jsonl");
  writeJsonl(path, [
    ...records(),
    {
      timestamp: "2026-05-01T00:00:08.000Z",
      type: "system",
      subtype: "turn_duration",
    },
  ]);

  const turns = await parseClaudeSessionHistoryJsonl({
    path,
    sessionId: "session-123",
    mode: "sync",
  });

  assert.equal(turns[1].backendTurnId, "claude:session-123:line:5");
  assert.equal(turns[1].status, "complete");
  assert.equal(turns[1].updatedAt, "2026-05-01T00:00:08.000Z");
});

test("claude history resolves only the cwd-bound parent session file", async () => {
  const home = tempDir();
  const cwd = "/repo";
  const sessionId = "session-123";

  await withEnv({ HOME: home }, async () => {
    const path = claudeSessionFilePath(cwd, sessionId);
    writeJsonl(path, records());
    const subagentPath = join(path, "..", sessionId, "subagents", "agent.jsonl");
    writeJsonl(subagentPath, [
      {
        timestamp: "2026-05-01T00:00:00.000Z",
        isSidechain: true,
        type: "user",
        message: { role: "user", content: "Subagent" },
      },
    ]);

    const resolved = await claudeBackend.resolveSessionHistorySource({
      sessionId,
      cwd,
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, true);
    assert.equal(resolved.source.path, path);

    const result = await claudeBackend.readSessionHistory({
      sessionId,
      cwd,
      env: {},
      resolvedBackendArgs: [],
      source: resolved.source,
      mode: "bootstrap",
    });
    assert.equal(result.turns.length, 2);
    assert.equal(result.turns[0].userText, "Question A");
  });
});

test("claude history parser reports malformed jsonl with file and line", async () => {
  const dir = tempDir();
  const path = join(dir, "session-bad.jsonl");
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, `${JSON.stringify(records()[0])}\n{not-json}\n`);

  await assert.rejects(
    () =>
      parseClaudeSessionHistoryJsonl({
        path,
        sessionId: "session-123",
        mode: "bootstrap",
      }),
    new RegExp(`failed to parse Claude session history ${path}:2`),
  );
});

test("claude history rejects path-like session ids", async () => {
  const home = tempDir();

  await withEnv({ HOME: home }, async () => {
    assert.throws(
      () => claudeSessionFilePath("/repo", "../../outside"),
      /claude session id must be a session id, not a path/,
    );
    const resolved = await claudeBackend.resolveSessionHistorySource({
      sessionId: "../../outside",
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, false);
    assert.equal(resolved.reason, "claude session id must be a session id, not a path");
  });
});

test("claude history source is unavailable when the cwd-bound session file is missing", async () => {
  const home = tempDir();

  await withEnv({ HOME: home }, async () => {
    const resolved = await claudeBackend.resolveSessionHistorySource({
      sessionId: "missing-session",
      cwd: "/repo",
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, false);
    assert.match(
      resolved.reason,
      /claude session file not found: .*\.claude\/projects\/-repo\/missing-session\.jsonl/,
    );
  });
});
