import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import {
  cursorBackend,
  cursorStoreDbPath,
  cursorWorkspaceHash,
  parseCursorRootBlobMessageIds,
  parseCursorSessionHistoryStore,
} from "../packages/core/dist/backends/cursor.js";
import {
  CURSOR_STORE_CREATED_AT,
  cursorRootBlob,
  idFor,
  writeCursorStore,
  writeCursorStoreAtPath,
  writeCursorStoreWithMetaValue,
} from "./helpers/cursor-store.mjs";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-cursor-history-"));
}

function validationContext(cwd, sessionId) {
  return {
    sessionId,
    cwd,
    env: {},
    resolvedBackendArgs: [],
  };
}

test("cursor history pathing uses md5 cwd buckets under HOME", async () => {
  const home = tempDir();
  const cwd = "/repo";
  const sessionId = "cursor-session-1";

  await withEnv({ HOME: home }, async () => {
    assert.equal(cursorWorkspaceHash(cwd), createHash("md5").update(cwd).digest("hex"));
    assert.equal(
      cursorStoreDbPath(cwd, sessionId),
      join(home, ".cursor", "chats", cursorWorkspaceHash(cwd), sessionId, "store.db"),
    );
  });
});

test("cursor validation reads deterministic store meta and rejects invalid ids and stores", async () => {
  const home = tempDir();
  const cwd = "/repo";

  await withEnv({ HOME: home }, async () => {
    const pathLike = await cursorBackend.validateSessionId(validationContext(cwd, "one/two"));
    assert.equal(pathLike.valid, false);
    assert.match(pathLike.reason, /not a path/);

    const missing = await cursorBackend.validateSessionId(validationContext(cwd, "missing"));
    assert.equal(missing.valid, false);
    assert.match(missing.reason, /cursor store is unreadable/);

    writeCursorStoreWithMetaValue(cwd, "bad-hex", "zz");
    const badHex = await cursorBackend.validateSessionId(validationContext(cwd, "bad-hex"));
    assert.equal(badHex.valid, false);
    assert.match(badHex.reason, /hex-encoded JSON/);

    writeCursorStoreWithMetaValue(cwd, "bad-shape", Buffer.from("{}", "utf8").toString("hex"));
    const badShape = await cursorBackend.validateSessionId(validationContext(cwd, "bad-shape"));
    assert.equal(badShape.valid, false);
    assert.match(badShape.reason, /must decode to JSON/);

    writeCursorStore({
      cwd,
      sessionId: "mismatch",
      agentId: "other-agent",
      messageIds: [],
      messages: [],
    });
    const mismatch = await cursorBackend.validateSessionId(validationContext(cwd, "mismatch"));
    assert.equal(mismatch.valid, false);
    assert.match(mismatch.reason, /does not match session "mismatch"/);

    writeCursorStore({
      cwd,
      sessionId: "valid-session",
      messageIds: [],
      messages: [],
    });
    assert.deepEqual(
      await cursorBackend.validateSessionId(validationContext(cwd, "valid-session")),
      {
        valid: true,
      },
    );
  });
});

test("cursor root blob parser returns ordered message ids", () => {
  const ids = [idFor(1), idFor(2), idFor(3)];

  assert.deepEqual(parseCursorRootBlobMessageIds(cursorRootBlob(ids)), ids);
  assert.throws(
    () => parseCursorRootBlobMessageIds(Buffer.from([10, 32, 1])),
    /truncated length-delimited field/,
  );
});

test("cursor history parser returns two complete turns and prefers final answers", async () => {
  const home = tempDir();
  const cwd = "/repo";
  const sessionId = "cursor-session-1";
  const messageIds = [
    idFor(1),
    idFor(2),
    idFor(3),
    idFor(4),
    idFor(5),
    idFor(6),
    idFor(7),
    idFor(8),
  ];

  await withEnv({ HOME: home }, async () => {
    const path = writeCursorStore({
      cwd,
      sessionId,
      messageIds,
      messages: [
        [idFor(1), { role: "user", content: "<user_info>internal context</user_info>" }],
        [
          idFor(2),
          {
            role: "user",
            content: "<user_query>What changed?</user_query>",
            providerOptions: { cursor: { requestId: "request-a" } },
          },
        ],
        [idFor(3), { role: "assistant", content: [{ type: "text", text: "Draft answer" }] }],
        [
          idFor(4),
          {
            role: "assistant",
            content: [{ type: "text", text: "Final answer" }],
            providerOptions: { cursor: { openaiPhase: "final_answer" } },
          },
        ],
        [idFor(5), { role: "assistant", content: "Late draft should not win" }],
        [
          idFor(6),
          {
            role: "user",
            content: "Second question",
            providerOptions: { cursor: { requestId: "request-b" } },
          },
        ],
        [idFor(7), { role: "assistant", content: "Second answer" }],
        [idFor(8), { role: "user", content: [{ type: "text", text: "Open question" }] }],
      ],
    });

    assert.deepEqual(parseCursorSessionHistoryStore({ path, sessionId, mode: "bootstrap" }), [
      {
        backendTurnId: "request-a",
        status: "complete",
        startedAt: "2026-05-01T00:00:00.000Z",
        updatedAt: "2026-05-01T00:00:00.001Z",
        userText: "What changed?",
        assistantText: "Final answer",
      },
      {
        backendTurnId: "request-b",
        status: "complete",
        startedAt: "2026-05-01T00:00:00.001Z",
        updatedAt: "2026-05-01T00:00:00.002Z",
        userText: "Second question",
        assistantText: "Second answer",
      },
    ]);

    const syncTurns = parseCursorSessionHistoryStore({ path, sessionId, mode: "sync" });
    assert.equal(syncTurns.length, 3);
    assert.deepEqual(syncTurns[2], {
      backendTurnId: idFor(8),
      status: "open",
      startedAt: "2026-05-01T00:00:00.002Z",
      updatedAt: "2026-05-01T00:00:00.002Z",
      userText: "Open question",
      assistantText: null,
    });
  });
});

test("cursor history parser rejects malformed root and missing blobs, and ignores non-message blobs", async () => {
  const home = tempDir();
  const cwd = "/repo";

  await withEnv({ HOME: home }, async () => {
    const malformedRootPath = writeCursorStore({
      cwd,
      sessionId: "bad-root",
      messageIds: [idFor(1)],
      messages: [[idFor(1), { role: "user", content: "Question" }]],
      rootData: Buffer.from([10, 32, 1]),
    });
    assert.throws(
      () =>
        parseCursorSessionHistoryStore({
          path: malformedRootPath,
          sessionId: "bad-root",
          mode: "bootstrap",
        }),
      /malformed Cursor root blob/,
    );

    const missingBlobPath = writeCursorStore({
      cwd,
      sessionId: "missing-blob",
      messageIds: [idFor(2)],
      messages: [],
    });
    assert.throws(
      () =>
        parseCursorSessionHistoryStore({
          path: missingBlobPath,
          sessionId: "missing-blob",
          mode: "bootstrap",
        }),
      /message blob "0202.*" is missing/,
    );

    const malformedBlobPath = writeCursorStore({
      cwd,
      sessionId: "bad-blob",
      messageIds: [idFor(3), idFor(4), idFor(5), idFor(6)],
      messages: [
        [idFor(3), Buffer.from("{not-json", "utf8")],
        [idFor(4), { content: "object without role" }],
        [idFor(5), { role: "user", content: "Question" }],
        [idFor(6), { role: "assistant", content: "Answer" }],
      ],
    });
    assert.deepEqual(
      parseCursorSessionHistoryStore({
        path: malformedBlobPath,
        sessionId: "bad-blob",
        mode: "bootstrap",
      }),
      [
        {
          backendTurnId: idFor(5),
          status: "complete",
          startedAt: "2026-05-01T00:00:00.000Z",
          updatedAt: "2026-05-01T00:00:00.001Z",
          userText: "Question",
          assistantText: "Answer",
        },
      ],
    );
  });
});

test("cursor history resolves and reads the deterministic store source", async () => {
  const home = tempDir();
  const cwd = "/repo";
  const sessionId = "cursor-session-1";
  const messageIds = [idFor(10), idFor(11)];

  await withEnv({ HOME: home }, async () => {
    const path = writeCursorStore({
      cwd,
      sessionId,
      messageIds,
      messages: [
        [idFor(10), { role: "user", content: "Question" }],
        [idFor(11), { role: "assistant", content: "Answer" }],
      ],
    });

    const resolved = await cursorBackend.resolveSessionHistorySource({
      sessionId,
      cwd,
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, true);
    assert.deepEqual(resolved.source, {
      kind: "custom",
      label: path,
      changeToken: {
        kind: "cursor-store",
        path,
        agentId: sessionId,
        latestRootBlobId: idFor(250),
        createdAt: CURSOR_STORE_CREATED_AT,
      },
    });

    const result = await cursorBackend.readSessionHistory({
      sessionId,
      cwd,
      env: {},
      resolvedBackendArgs: [],
      source: resolved.source,
      mode: "bootstrap",
    });
    assert.deepEqual(result.source, resolved.source);
    assert.deepEqual(result.cursor, { kind: "cursor-store", latestRootBlobId: idFor(250) });
    assert.equal(result.turns.length, 1);
    assert.equal(result.turns[0].assistantText, "Answer");
  });
});

test("cursor history source rejects stores that escape the chats root", async () => {
  const home = tempDir();
  const cwd = "/repo";
  const sessionId = "cursor-escape";

  await withEnv({ HOME: home }, async () => {
    const escapedPath = join(home, "outside-store.db");
    writeCursorStoreAtPath({
      path: escapedPath,
      sessionId,
      messageIds: [idFor(12), idFor(13)],
      messages: [
        [idFor(12), { role: "user", content: "Question" }],
        [idFor(13), { role: "assistant", content: "Answer" }],
      ],
    });
    const deterministicPath = cursorStoreDbPath(cwd, sessionId);
    mkdirSync(dirname(deterministicPath), { recursive: true });
    symlinkSync(escapedPath, deterministicPath);

    const resolved = await cursorBackend.resolveSessionHistorySource({
      sessionId,
      cwd,
      env: {},
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, false);
    assert.equal(resolved.reason, "cursor store escaped the chats root");
  });
});
