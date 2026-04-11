import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  interruptTurnWithGrace,
  isExternalInterrupt,
  waitForTurnId,
} from "../dist/backends/codex.js";

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

test("waitForTurnId: resolves immediately when turn id is already known", async () => {
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    turnIdWaiters: [],
  };
  assert.equal(await waitForTurnId(state, 50), "turn-1");
  assert.equal(state.turnIdWaiters.length, 0);
});

test("interruptTurnWithGrace: waits briefly for async turn id before interrupting", async () => {
  const calls = [];
  const state = {
    threadId: "thread-1",
    turnId: null,
    turnIdWaiters: [],
  };
  const client = {
    async call(method, params) {
      calls.push({ method, params });
      return null;
    },
  };

  const interrupt = interruptTurnWithGrace(client, state, 100);
  assert.equal(state.turnIdWaiters.length, 1);
  state.turnId = "turn-42";
  state.turnIdWaiters.shift()?.("turn-42");

  assert.equal(await interrupt, true);
  assert.deepEqual(calls, [
    {
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-42" },
    },
  ]);
});

test("interruptTurnWithGrace: gives up cleanly when no turn id arrives", async () => {
  const calls = [];
  const state = {
    threadId: "thread-1",
    turnId: null,
    turnIdWaiters: [],
  };
  const client = {
    async call(method, params) {
      calls.push({ method, params });
      return null;
    },
  };

  assert.equal(await interruptTurnWithGrace(client, state, 10), false);
  assert.deepEqual(calls, []);
  assert.equal(state.turnIdWaiters.length, 0);
});
