import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  confirmInterrupt,
  interruptTurnWithGrace,
  interruptTurnWithRetry,
  isExternalInterrupt,
  waitForTurnCompletion,
  waitForTurnId,
} from "../packages/core/dist/backends/codex.js";

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

test("interruptTurnWithRetry: retries after the initial grace window and interrupts on late turn id", async () => {
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

  const interrupt = interruptTurnWithRetry(client, state, [5, 50]);
  setTimeout(() => {
    state.turnId = "turn-late";
    state.turnIdWaiters.shift()?.("turn-late");
  }, 15);

  assert.equal(await interrupt, true);
  assert.deepEqual(calls, [
    {
      method: "turn/interrupt",
      params: { threadId: "thread-1", turnId: "turn-late" },
    },
  ]);
});

test("waitForTurnCompletion: resolves immediately when the turn is already completed", async () => {
  const state = {
    turnCompleted: true,
    turnCompletionWaiters: [],
  };
  assert.equal(await waitForTurnCompletion(state, 50), true);
  assert.equal(state.turnCompletionWaiters.length, 0);
});

test("confirmInterrupt: reports missing_turn_id when no turn id arrives in time", async () => {
  const state = {
    threadId: "thread-1",
    turnId: null,
    turnIdWaiters: [],
    turnCompletionWaiters: [],
    streamedText: "",
    completedText: "",
    lastStreamItemId: null,
    turnStatus: "in_progress",
    turnError: null,
    turnCompleted: false,
    onText() {},
    resolveCompleted: null,
  };

  const result = await confirmInterrupt(
    {
      async call() {
        throw new Error("should not be called");
      },
    },
    state,
    [5, 5],
    10,
  );

  assert.deepEqual(result, {
    confirmed: false,
    reason: "missing_turn_id",
    errorMessage: undefined,
  });
});

test("confirmInterrupt: reports rpc_error when turn/interrupt fails", async () => {
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    turnIdWaiters: [],
    turnCompletionWaiters: [],
    streamedText: "",
    completedText: "",
    lastStreamItemId: null,
    turnStatus: "in_progress",
    turnError: null,
    turnCompleted: false,
    onText() {},
    resolveCompleted: null,
  };

  const result = await confirmInterrupt(
    {
      async call() {
        throw new Error("rpc failed");
      },
    },
    state,
    [5],
    10,
  );

  assert.deepEqual(result, {
    confirmed: false,
    reason: "rpc_error",
    errorMessage: "rpc failed",
  });
});

test("confirmInterrupt: confirms only after an interrupted terminal event arrives", async () => {
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    turnIdWaiters: [],
    turnCompletionWaiters: [],
    streamedText: "",
    completedText: "",
    lastStreamItemId: null,
    turnStatus: "in_progress",
    turnError: null,
    turnCompleted: false,
    onText() {},
    resolveCompleted: null,
  };

  const resultPromise = confirmInterrupt(
    {
      async call() {
        setTimeout(() => {
          state.turnStatus = "interrupted";
          state.turnCompleted = true;
          state.turnCompletionWaiters.shift()?.();
        }, 5);
        return null;
      },
    },
    state,
    [5],
    50,
  );

  assert.deepEqual(await resultPromise, { confirmed: true });
});

test("confirmInterrupt: reports wrong_terminal_status when the turn ends without interruption", async () => {
  const state = {
    threadId: "thread-1",
    turnId: "turn-1",
    turnIdWaiters: [],
    turnCompletionWaiters: [],
    streamedText: "",
    completedText: "",
    lastStreamItemId: null,
    turnStatus: "in_progress",
    turnError: null,
    turnCompleted: false,
    onText() {},
    resolveCompleted: null,
  };

  const resultPromise = confirmInterrupt(
    {
      async call() {
        setTimeout(() => {
          state.turnStatus = "completed";
          state.turnCompleted = true;
          state.turnCompletionWaiters.shift()?.();
        }, 5);
        return null;
      },
    },
    state,
    [5],
    50,
  );

  assert.deepEqual(await resultPromise, {
    confirmed: false,
    reason: "wrong_terminal_status",
    turnStatus: "completed",
  });
});
