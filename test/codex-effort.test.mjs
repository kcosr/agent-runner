import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mapEffortToCodex, normalizeCodexModel } from "../dist/backends/codex.js";

test("codex effort: off → null (omit flag)", () => {
  assert.equal(mapEffortToCodex("off"), null);
});

test("codex effort: minimal/low/medium/high pass through", () => {
  assert.equal(mapEffortToCodex("minimal"), "minimal");
  assert.equal(mapEffortToCodex("low"), "low");
  assert.equal(mapEffortToCodex("medium"), "medium");
  assert.equal(mapEffortToCodex("high"), "high");
});

test("codex effort: xhigh passes through", () => {
  assert.equal(mapEffortToCodex("xhigh"), "xhigh");
});

test("codex effort: max maps to xhigh", () => {
  assert.equal(mapEffortToCodex("max"), "xhigh");
});

test("codex model normalizer: strips provider prefix", () => {
  assert.equal(normalizeCodexModel("openai-codex/gpt-5.4"), "gpt-5.4");
  assert.equal(normalizeCodexModel("anthropic/claude-sonnet-4-6"), "claude-sonnet-4-6");
});

test("codex model normalizer: unprefixed model passes through", () => {
  assert.equal(normalizeCodexModel("gpt-5.4"), "gpt-5.4");
});

test("codex model normalizer: trailing slash is safe (returns original)", () => {
  assert.equal(normalizeCodexModel("foo/"), "foo/");
});
