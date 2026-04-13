import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  UnknownBackendError,
  knownBackends,
  resolveBackend,
} from "../packages/core/dist/backends/registry.js";

test("registry: claude and codex are known", () => {
  const known = knownBackends();
  assert.ok(known.includes("claude"));
  assert.ok(known.includes("codex"));
});

test("registry: resolveBackend returns the adapter", () => {
  const claude = resolveBackend("claude");
  assert.equal(claude.id, "claude");
  const codex = resolveBackend("codex");
  assert.equal(codex.id, "codex");
});

test("registry: unknown backend throws UnknownBackendError", () => {
  assert.throws(() => resolveBackend("gemini"), UnknownBackendError);
});
