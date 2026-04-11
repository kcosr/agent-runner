import { strict as assert } from "node:assert";
import { test } from "node:test";
import { isExternalInterrupt } from "../dist/backends/codex.js";

test("isExternalInterrupt: turn=interrupted with no internal cause → external", () => {
  assert.equal(isExternalInterrupt("interrupted", false, false), true);
});

test("isExternalInterrupt: our timeout caused the interrupt → not external", () => {
  assert.equal(isExternalInterrupt("interrupted", true, false), false);
});

test("isExternalInterrupt: our abort caused the interrupt → not external", () => {
  assert.equal(isExternalInterrupt("interrupted", false, true), false);
});

test("isExternalInterrupt: both flags set (theoretical) → not external", () => {
  assert.equal(isExternalInterrupt("interrupted", true, true), false);
});

test("isExternalInterrupt: turn=completed → not external", () => {
  assert.equal(isExternalInterrupt("completed", false, false), false);
});

test("isExternalInterrupt: turn=failed → not external (failures retry, interrupts don't)", () => {
  assert.equal(isExternalInterrupt("failed", false, false), false);
});

test("isExternalInterrupt: turn=in_progress → not external (we never reached completion)", () => {
  assert.equal(isExternalInterrupt("in_progress", false, false), false);
});

test("isExternalInterrupt: unknown turn status → not external", () => {
  assert.equal(isExternalInterrupt("unknown", false, false), false);
});
