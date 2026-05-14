import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import Database from "better-sqlite3";
import {
  opencodeBackend,
  opencodeDbPath,
  parseOpenCodeSessionHistorySnapshot,
} from "../packages/core/dist/backends/opencode.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-opencode-history-"));
}

function createOpenCodeDb(dataDir, cwd = "/repo", sessionId = "ses_123") {
  mkdirSync(dataDir, { recursive: true });
  const dbPath = join(dataDir, "opencode.db");
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE session (
      id text PRIMARY KEY,
      directory text NOT NULL,
      title text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL
    );
    CREATE TABLE message (
      id text PRIMARY KEY,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
    CREATE TABLE part (
      id text PRIMARY KEY,
      message_id text NOT NULL,
      session_id text NOT NULL,
      time_created integer NOT NULL,
      time_updated integer NOT NULL,
      data text NOT NULL
    );
  `);
  db.prepare(
    "INSERT INTO session (id, directory, title, time_created, time_updated) VALUES (?, ?, ?, ?, ?)",
  ).run(sessionId, cwd, "Session title", 1_000, 8_000);
  return { db, dbPath, sessionId, cwd };
}

function insertMessage(db, row) {
  db.prepare(
    "INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?)",
  ).run(row.id, row.sessionId, row.created, row.updated, JSON.stringify(row.data));
}

function insertPart(db, row) {
  db.prepare(
    "INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, ?, ?, ?, ?)",
  ).run(row.id, row.messageId, row.sessionId, row.created, row.updated, JSON.stringify(row.data));
}

function seedTurns(db, sessionId) {
  insertMessage(db, {
    id: "msg_user_a",
    sessionId,
    created: 1_000,
    updated: 1_000,
    data: {
      role: "user",
      time: { created: 1_000 },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
  });
  insertPart(db, {
    id: "prt_user_a_text",
    messageId: "msg_user_a",
    sessionId,
    created: 1_000,
    updated: 1_000,
    data: { type: "text", text: "Question A" },
  });
  insertMessage(db, {
    id: "msg_assistant_a",
    sessionId,
    created: 1_100,
    updated: 1_200,
    data: {
      role: "assistant",
      time: { created: 1_100, completed: 1_200 },
      parentID: "msg_user_a",
      finish: "stop",
      modelID: "m",
      providerID: "p",
      mode: "build",
      path: { cwd: "/repo", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  insertPart(db, {
    id: "prt_assistant_a_text",
    messageId: "msg_assistant_a",
    sessionId,
    created: 1_100,
    updated: 1_200,
    data: { type: "text", text: "Answer A", time: { start: 1_100, end: 1_200 } },
  });

  insertMessage(db, {
    id: "msg_user_b",
    sessionId,
    created: 2_000,
    updated: 2_000,
    data: {
      role: "user",
      time: { created: 2_000 },
      agent: "build",
      model: { providerID: "p", modelID: "m" },
    },
  });
  insertPart(db, {
    id: "prt_user_b_text",
    messageId: "msg_user_b",
    sessionId,
    created: 2_000,
    updated: 2_000,
    data: { type: "text", text: "Question B" },
  });
  insertMessage(db, {
    id: "msg_assistant_b",
    sessionId,
    created: 2_100,
    updated: 2_200,
    data: {
      role: "assistant",
      time: { created: 2_100 },
      parentID: "msg_user_b",
      modelID: "m",
      providerID: "p",
      mode: "build",
      path: { cwd: "/repo", root: "/" },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  insertPart(db, {
    id: "prt_assistant_b_text",
    messageId: "msg_assistant_b",
    sessionId,
    created: 2_100,
    updated: 2_200,
    data: { type: "text", text: "Answer B" },
  });
}

test("opencode history parser imports complete turns and leaves latest unfinished turn open in sync", () => {
  const dir = tempDir();
  const { db, dbPath, sessionId } = createOpenCodeDb(dir);
  try {
    seedTurns(db, sessionId);

    const bootstrap = parseOpenCodeSessionHistorySnapshot({
      db,
      dbPath,
      sessionId,
      mode: "bootstrap",
    });
    assert.deepEqual(
      bootstrap.turns.map((turn) => ({
        backendTurnId: turn.backendTurnId,
        status: turn.status,
        userText: turn.userText,
        assistantText: turn.assistantText,
      })),
      [
        {
          backendTurnId: "msg_user_a",
          status: "complete",
          userText: "Question A",
          assistantText: "Answer A",
        },
        {
          backendTurnId: "msg_user_b",
          status: "complete",
          userText: "Question B",
          assistantText: "Answer B",
        },
      ],
    );

    const sync = parseOpenCodeSessionHistorySnapshot({ db, dbPath, sessionId, mode: "sync" });
    assert.equal(sync.turns[0].status, "complete");
    assert.equal(sync.turns[1].status, "open");
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode history parser keeps trailing user-only turns open only during sync", () => {
  const dir = tempDir();
  const { db, dbPath, sessionId } = createOpenCodeDb(dir);
  try {
    seedTurns(db, sessionId);
    insertMessage(db, {
      id: "msg_user_c",
      sessionId,
      created: 3_000,
      updated: 3_000,
      data: {
        role: "user",
        time: { created: 3_000 },
        agent: "build",
        model: { providerID: "p", modelID: "m" },
      },
    });
    insertPart(db, {
      id: "prt_user_c_text",
      messageId: "msg_user_c",
      sessionId,
      created: 3_000,
      updated: 3_000,
      data: { type: "text", text: "Question C" },
    });

    const bootstrap = parseOpenCodeSessionHistorySnapshot({
      db,
      dbPath,
      sessionId,
      mode: "bootstrap",
    });
    assert.deepEqual(
      bootstrap.turns.map((turn) => turn.backendTurnId),
      ["msg_user_a", "msg_user_b"],
    );

    const sync = parseOpenCodeSessionHistorySnapshot({ db, dbPath, sessionId, mode: "sync" });
    assert.deepEqual(
      sync.turns.map((turn) => [turn.backendTurnId, turn.status, turn.userText]),
      [
        ["msg_user_a", "complete", "Question A"],
        ["msg_user_b", "complete", "Question B"],
        ["msg_user_c", "open", "Question C"],
      ],
    );
  } finally {
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode history resolves and validates sessions by cwd-bound sqlite data", async () => {
  const home = tempDir();
  const dataDir = join(home, ".local", "share", "opencode");
  const { db, sessionId, cwd } = createOpenCodeDb(dataDir);
  try {
    seedTurns(db, sessionId);
    db.close();

    await withEnv({ HOME: home }, async () => {
      assert.equal(opencodeDbPath({ HOME: home }), join(dataDir, "opencode.db"));
      const validation = await opencodeBackend.validateSessionId({
        sessionId,
        cwd,
        env: { HOME: home },
        resolvedBackendArgs: [],
      });
      assert.deepEqual(validation, { valid: true });

      const wrongCwd = await opencodeBackend.validateSessionId({
        sessionId,
        cwd: "/other",
        env: { HOME: home },
        resolvedBackendArgs: [],
      });
      assert.equal(wrongCwd.valid, false);
      assert.match(wrongCwd.reason, /belongs to cwd/);

      const source = await opencodeBackend.resolveSessionHistorySource({
        sessionId,
        cwd,
        env: { HOME: home },
        resolvedBackendArgs: [],
      });
      assert.equal(source.available, true);
      assert.equal(source.source.kind, "custom");

      const history = await opencodeBackend.readSessionHistory({
        sessionId,
        cwd,
        env: { HOME: home },
        resolvedBackendArgs: [],
        source: source.source,
        mode: "bootstrap",
      });
      assert.equal(history.turns.length, 2);
      assert.equal(history.turns[0].userText, "Question A");
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("opencode history honors OpenCode data directory env fallbacks", async () => {
  const home = tempDir();
  const explicitDataDir = join(home, "agent-runner-opencode");
  const opencodeDataDir = join(home, "opencode-env");
  const { db: explicitDb, sessionId, cwd } = createOpenCodeDb(explicitDataDir);
  const { db: fallbackDb } = createOpenCodeDb(opencodeDataDir, cwd, sessionId);
  try {
    seedTurns(explicitDb, sessionId);
    seedTurns(fallbackDb, sessionId);
    explicitDb.close();
    fallbackDb.close();

    await withEnv(
      {
        HOME: home,
        OPENCODE_DATA_DIR: opencodeDataDir,
        AGENT_RUNNER_OPENCODE_DATA_DIR: explicitDataDir,
      },
      async () => {
        assert.equal(opencodeDbPath(process.env), join(explicitDataDir, "opencode.db"));
        const source = await opencodeBackend.resolveSessionHistorySource({
          sessionId,
          cwd,
          env: process.env,
          resolvedBackendArgs: [],
        });
        assert.equal(source.available, true);
        assert.equal(source.source.changeToken.path, join(explicitDataDir, "opencode.db"));
      },
    );

    await withEnv({ HOME: home, OPENCODE_DATA_DIR: opencodeDataDir }, async () => {
      assert.equal(opencodeDbPath(process.env), join(opencodeDataDir, "opencode.db"));
      const source = await opencodeBackend.resolveSessionHistorySource({
        sessionId,
        cwd,
        env: process.env,
        resolvedBackendArgs: [],
      });
      assert.equal(source.available, true);
      assert.equal(source.source.changeToken.path, join(opencodeDataDir, "opencode.db"));
    });
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("opencode history reports missing and unreadable databases as unavailable", async () => {
  const home = tempDir();
  try {
    const missing = await opencodeBackend.resolveSessionHistorySource({
      sessionId: "ses_123",
      cwd: "/repo",
      env: { HOME: home },
      resolvedBackendArgs: [],
    });
    assert.equal(missing.available, false);
    assert.match(missing.reason, /opencode database not found/);

    const dataDir = join(home, ".local", "share", "opencode");
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(join(dataDir, "opencode.db"), "not sqlite");
    const unreadable = await opencodeBackend.resolveSessionHistorySource({
      sessionId: "ses_123",
      cwd: "/repo",
      env: { HOME: home },
      resolvedBackendArgs: [],
    });
    assert.equal(unreadable.available, false);
    assert.match(unreadable.reason, /opencode database is unreadable/);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("opencode history rejects path-like session ids", async () => {
  const home = tempDir();
  await withEnv({ HOME: home }, async () => {
    const resolved = await opencodeBackend.resolveSessionHistorySource({
      sessionId: "../outside",
      cwd: "/repo",
      env: { HOME: home },
      resolvedBackendArgs: [],
    });
    assert.equal(resolved.available, false);
    assert.equal(resolved.reason, "opencode session id must be a session id, not a path");
  });
});
