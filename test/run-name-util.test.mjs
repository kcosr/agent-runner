import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  normalizeOptionalRunName,
  normalizeRunNameMutation,
  trimRunName,
} from "../packages/core/dist/util/run-name.js";

test("run-name util: trimRunName trims surrounding whitespace", () => {
  assert.equal(trimRunName("  Run naming  "), "Run naming");
});

test("run-name util: trimRunName rejects whitespace-only values", () => {
  assert.throws(() => trimRunName("   "), /run name cannot be empty/);
});

test("run-name util: normalizeOptionalRunName returns null for undefined", () => {
  assert.equal(normalizeOptionalRunName(undefined), null);
});

test("run-name util: normalizeOptionalRunName trims concrete values", () => {
  assert.equal(normalizeOptionalRunName("  Web dashboard "), "Web dashboard");
});

test("run-name util: normalizeRunNameMutation returns null when clear is set", () => {
  assert.equal(normalizeRunNameMutation({ clear: true }), null);
});

test("run-name util: normalizeRunNameMutation rejects missing name without clear", () => {
  assert.throws(() => normalizeRunNameMutation({}), /run name is required unless clear is set/);
});

test("run-name util: normalizeRunNameMutation trims provided names", () => {
  assert.equal(
    normalizeRunNameMutation({ name: "  Daemon control plane " }),
    "Daemon control plane",
  );
});
