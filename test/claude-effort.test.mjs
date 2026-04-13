import { strict as assert } from "node:assert";
import { test } from "node:test";

// claude-effort mapping is an internal function; we exercise it indirectly via
// the args-building path. Here we just verify the canonical enum shape via the
// schema so the mapping table has something to map against.

import { agentConfigSchema } from "../packages/core/dist/core/config/schema.js";

test("canonical effort enum accepts all 7 values", () => {
  const base = {
    schemaVersion: 1,
    name: "t",
    backend: "claude",
    tasks: [],
  };
  for (const effort of ["off", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    const result = agentConfigSchema.safeParse({ ...base, effort });
    assert.equal(result.success, true, `effort=${effort} should be accepted`);
  }
});

test("canonical effort enum rejects unknown values", () => {
  const base = {
    schemaVersion: 1,
    name: "t",
    backend: "claude",
    tasks: [],
  };
  for (const effort of ["none", "medium-high", "extreme", ""]) {
    const result = agentConfigSchema.safeParse({ ...base, effort });
    assert.equal(result.success, false, `effort=${effort} should be rejected`);
  }
});

test("backend enum accepts claude and codex only", () => {
  const base = {
    schemaVersion: 1,
    name: "t",
    tasks: [],
  };
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "claude" }).success, true);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "codex" }).success, true);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "gemini" }).success, false);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "" }).success, false);
});
