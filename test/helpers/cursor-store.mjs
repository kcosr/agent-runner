import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import Database from "better-sqlite3";
import { cursorStoreDbPath } from "../../packages/core/dist/backends/cursor.js";

export const CURSOR_STORE_CREATED_AT = Date.parse("2026-05-01T00:00:00.000Z");

export function idFor(value) {
  return value.toString(16).padStart(2, "0").repeat(32);
}

function encodeVarint(value) {
  const bytes = [];
  let remaining = value;
  while (remaining >= 0x80) {
    bytes.push((remaining & 0x7f) | 0x80);
    remaining = Math.floor(remaining / 0x80);
  }
  bytes.push(remaining);
  return Buffer.from(bytes);
}

export function cursorRootBlob(messageIds) {
  const chunks = [
    Buffer.concat([encodeVarint(16), encodeVarint(7)]),
    Buffer.concat([encodeVarint(42), encodeVarint(7), Buffer.from("ignored")]),
  ];
  for (const id of messageIds) {
    chunks.push(Buffer.concat([encodeVarint(10), encodeVarint(32), Buffer.from(id, "hex")]));
  }
  return Buffer.concat(chunks);
}

export function createEmptyCursorStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.exec(
    "CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); CREATE TABLE blobs (id TEXT PRIMARY KEY, data BLOB)",
  );
  return db;
}

export function writeCursorStoreAtPath({
  path,
  sessionId,
  agentId = sessionId,
  createdAt = CURSOR_STORE_CREATED_AT,
  latestRootBlobId = idFor(250),
  messageIds = [],
  messages = [],
  rootData = cursorRootBlob(messageIds),
}) {
  const db = createEmptyCursorStore(path);
  try {
    const meta = { agentId, latestRootBlobId, createdAt };
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run(
      "0",
      Buffer.from(JSON.stringify(meta), "utf8").toString("hex"),
    );
    db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)").run(latestRootBlobId, rootData);
    const insertBlob = db.prepare("INSERT INTO blobs (id, data) VALUES (?, ?)");
    for (const [id, message] of messages) {
      insertBlob.run(
        id,
        Buffer.isBuffer(message) ? message : Buffer.from(JSON.stringify(message), "utf8"),
      );
    }
  } finally {
    db.close();
  }
  return path;
}

export function writeCursorStore(options) {
  return writeCursorStoreAtPath({
    ...options,
    path: cursorStoreDbPath(options.cwd, options.sessionId),
  });
}

export function writeCursorStoreWithMetaValue(cwd, sessionId, value) {
  const path = cursorStoreDbPath(cwd, sessionId);
  const db = createEmptyCursorStore(path);
  try {
    db.prepare("INSERT INTO meta (key, value) VALUES (?, ?)").run("0", value);
  } finally {
    db.close();
  }
  return path;
}
