import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  ScheduleValidationError,
  advanceRecurringSchedule,
  deriveScheduleState,
  parseDurationMs,
  resolveScheduleInput,
  sampleFutureOccurrences,
} from "../packages/core/dist/core/run/schedule.js";

const now = new Date("2026-04-25T00:00:00.000Z");
const relaxedEnv = {
  TASK_RUNNER_MIN_SCHEDULE_DELAY_SEC: "1",
  TASK_RUNNER_MIN_RECURRENCE_INTERVAL_SEC: "60",
};

test("schedule resolves valid one-time at input and derives future/due states", () => {
  const schedule = resolveScheduleInput(
    { at: "2026-04-25T00:10:00.000Z" },
    { now, env: relaxedEnv },
  );

  assert.deepEqual(schedule, {
    enabled: true,
    runAt: "2026-04-25T00:10:00.000Z",
    recurrence: null,
  });
  assert.equal(deriveScheduleState(null, now), "none");
  assert.equal(deriveScheduleState({ ...schedule, enabled: false }, now), "paused");
  assert.equal(deriveScheduleState(schedule, now), "future");
  assert.equal(deriveScheduleState(schedule, new Date("2026-04-25T00:10:00.000Z")), "due");
});

test("schedule resolves delay inputs relative to the supplied clock", () => {
  assert.equal(parseDurationMs("10m"), 600000);

  const schedule = resolveScheduleInput({ delay: "10m" }, { now, env: relaxedEnv });

  assert.equal(schedule.runAt, "2026-04-25T00:10:00.000Z");
  assert.equal(schedule.recurrence, null);
});

test("schedule rejects invalid one-time input and guardrail failures", () => {
  assert.throws(
    () => resolveScheduleInput({}, { now, env: relaxedEnv }),
    /exactly one of at, delay, or cron/,
  );
  assert.throws(
    () => resolveScheduleInput({ at: "bad" }, { now, env: relaxedEnv }),
    /invalid schedule timestamp/,
  );
  assert.throws(() => resolveScheduleInput({ delay: "10 seconds" }, { now }), /below minimum 300s/);
  assert.throws(
    () => resolveScheduleInput({ at: "2026-04-25T00:10:00.000Z", timezone: "UTC" }, { now }),
    /timezone is valid only with cron/,
  );
});

test("schedule resolves cron input with timezone defaults and mode defaults", () => {
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  const schedule = resolveScheduleInput({ cron: "*/5 * * * *" }, { now });

  assert.equal(schedule.enabled, true);
  assert.equal(schedule.runAt, "2026-04-25T00:05:00.000Z");
  assert.deepEqual(schedule.recurrence, {
    schedule: {
      type: "cron",
      expression: "*/5 * * * *",
      timezone,
    },
    mode: "clone",
    continueOnFailure: false,
  });
});

test("schedule validates cron timezone and recurrence interval guardrails", () => {
  assert.throws(
    () => resolveScheduleInput({ cron: "not cron", timezone: "UTC" }, { now }),
    ScheduleValidationError,
  );
  assert.throws(
    () => resolveScheduleInput({ cron: "*/5 * * * *", timezone: "No/Such_Zone" }, { now }),
    /invalid schedule timezone/,
  );
  assert.throws(
    () => resolveScheduleInput({ cron: "* * * * *", timezone: "UTC" }, { now }),
    /below minimum 300s/,
  );
});

test("schedule samples recurrence advancement with a bounded occurrence count", () => {
  const schedule = resolveScheduleInput(
    { cron: "0 22 * * *", timezone: "America/New_York", mode: "reuse" },
    { now },
  );
  const sample = sampleFutureOccurrences(schedule.recurrence, new Date(schedule.runAt));

  assert.equal(sample.length, 10);
  assert.ok(sample.every((date) => date instanceof Date));
});

test("schedule disables existing recurrence that violates the minimum interval", () => {
  const schedule = {
    enabled: true,
    runAt: "2026-04-25T00:01:00.000Z",
    recurrence: {
      schedule: {
        type: "cron",
        expression: "* * * * *",
        timezone: "UTC",
      },
      mode: "clone",
      continueOnFailure: false,
    },
  };

  const result = advanceRecurringSchedule(schedule, now);

  assert.equal(result.disabledReason, "minimum_interval_violation");
  assert.equal(result.schedule.enabled, false);
  assert.equal(result.schedule.runAt, schedule.runAt);
});
