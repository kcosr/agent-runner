import { strict as assert } from "node:assert";
import { test } from "node:test";

// claude-effort mapping is an internal function; we exercise it indirectly via
// the args-building path. Here we just verify the canonical enum shape via the
// schema so the mapping table has something to map against.

import { buildClaudeArgs } from "../packages/core/dist/backends/claude.js";
import { agentConfigSchema } from "../packages/core/dist/core/config/schema.js";

test("canonical effort enum accepts all 7 values", () => {
  const base = {
    schemaVersion: 1,
    name: "t",
    backend: "claude",
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
  };
  for (const effort of ["none", "medium-high", "extreme", ""]) {
    const result = agentConfigSchema.safeParse({ ...base, effort });
    assert.equal(result.success, false, `effort=${effort} should be rejected`);
  }
});

test("backend enum accepts the supported backend ids", () => {
  const base = {
    schemaVersion: 1,
    name: "t",
  };
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "claude" }).success, true);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "codex" }).success, true);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "cursor" }).success, true);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "passive" }).success, true);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "gemini" }).success, true);
  assert.equal(agentConfigSchema.safeParse({ ...base, backend: "" }).success, false);
});

test("buildClaudeArgs inserts backend args before prompt without conflict validation", () => {
  assert.deepEqual(
    buildClaudeArgs({
      model: "anthropic/claude-sonnet-4-6",
      effort: "xhigh",
      unrestricted: true,
      name: "Feature run",
      resumeSessionId: "claude-session-1",
      resolvedBackendArgs: ["--model", "opus", "--new-claude-flag"],
      prompt: "Inspect the repo",
    }),
    [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-sonnet-4-6",
      "--effort",
      "max",
      "--dangerously-skip-permissions",
      "--name",
      "Feature run",
      "--resume",
      "claude-session-1",
      "--model",
      "opus",
      "--new-claude-flag",
      "Inspect the repo",
    ],
  );
});
