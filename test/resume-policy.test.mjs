import assert from "node:assert/strict";
import test from "node:test";

import {
  canResumeWithoutMessage,
  hasRunnableTasks,
  missingBlockedResumeMessage,
  needsStoppedRunTaskReminder,
  resumeStatusRequiresExplicitMessage,
} from "../packages/core/dist/core/run/resume-policy.js";

function task(status) {
  return {
    id: `task-${status}`,
    title: status,
    body: "",
    notes: "",
    status,
  };
}

test("resume policy: runnable tasks are pending or in_progress only", () => {
  assert.equal(hasRunnableTasks({ t1: task("pending") }), true);
  assert.equal(hasRunnableTasks({ t1: task("in_progress") }), true);
  assert.equal(hasRunnableTasks({ t1: task("completed") }), false);
  assert.equal(hasRunnableTasks({ t1: task("blocked") }), false);
});

test("resume policy: blocked runs require an explicit message", () => {
  assert.equal(resumeStatusRequiresExplicitMessage("blocked"), true);
  assert.equal(resumeStatusRequiresExplicitMessage("success"), false);
  assert.equal(
    missingBlockedResumeMessage(),
    "cannot resume a blocked run without a follow-up message",
  );
});

test("resume policy: message-less resume matrix", () => {
  const cases = [
    {
      expected: true,
      finalTasks: { t1: task("pending") },
      hasAddedTasks: false,
      name: "success with pending task",
      status: "success",
    },
    {
      expected: true,
      finalTasks: {},
      hasAddedTasks: true,
      name: "success with added task",
      status: "success",
    },
    {
      expected: false,
      finalTasks: { t1: task("completed") },
      hasAddedTasks: false,
      name: "success with completed-only tasks",
      status: "success",
    },
    {
      expected: false,
      finalTasks: { t1: task("pending") },
      hasAddedTasks: false,
      name: "blocked with pending task",
      status: "blocked",
    },
    {
      expected: false,
      finalTasks: {},
      hasAddedTasks: true,
      name: "blocked with added task",
      status: "blocked",
    },
  ];

  for (const entry of cases) {
    assert.equal(
      canResumeWithoutMessage({
        finalTasks: entry.finalTasks,
        hasAddedTasks: entry.hasAddedTasks,
        status: entry.status,
      }),
      entry.expected,
      entry.name,
    );
  }
});

test("resume policy: stopped-run task reminders skip blocked runs", () => {
  assert.equal(
    needsStoppedRunTaskReminder({
      backend: "codex",
      finalTasks: { t1: task("pending") },
      status: "success",
    }),
    true,
  );
  assert.equal(
    needsStoppedRunTaskReminder({
      backend: "codex",
      finalTasks: { t1: task("pending") },
      status: "blocked",
    }),
    false,
  );
});
