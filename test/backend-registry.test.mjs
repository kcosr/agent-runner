import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  UnknownBackendError,
  knownBackends,
  resolveBackend,
} from "../packages/core/dist/backends/registry.js";

test("registry: claude, codex, cursor, pi, and passive are known", () => {
  const known = knownBackends();
  assert.ok(known.includes("claude"));
  assert.ok(known.includes("codex"));
  assert.ok(known.includes("cursor"));
  assert.ok(known.includes("pi"));
  assert.ok(known.includes("passive"));
});

test("registry: resolveBackend returns the adapter", () => {
  const claude = resolveBackend("claude");
  assert.equal(claude.id, "claude");
  const codex = resolveBackend("codex");
  assert.equal(codex.id, "codex");
  const cursor = resolveBackend("cursor");
  assert.equal(cursor.id, "cursor");
  const pi = resolveBackend("pi");
  assert.equal(pi.id, "pi");
});

test("registry: unknown backend throws UnknownBackendError", () => {
  assert.throws(() => resolveBackend("gemini"), UnknownBackendError);
});
