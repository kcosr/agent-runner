import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildNudgeMessage } from "../dist/runner/nudge.js";

function buildTasks(states) {
  const tasks = new Map();
  for (const s of states) {
    tasks.set(s.id, {
      id: s.id,
      title: s.title,
      body: "",
      status: s.status ?? "pending",
      notes: s.notes ?? "",
    });
  }
  return tasks;
}

test("nudge lists incomplete tasks with status and title", () => {
  const tasks = buildTasks([
    { id: "t1", title: "First", status: "completed" },
    { id: "t2", title: "Second", status: "in_progress" },
    { id: "t3", title: "Third", status: "pending" },
  ]);
  const msg = buildNudgeMessage(tasks, [], "/tmp/tasks.md");

  assert.ok(msg.includes("t2 (status: in_progress) — Second"));
  assert.ok(msg.includes("t3 (status: pending) — Third"));
  assert.ok(!msg.includes("t1 (status: completed)"));
});

test("nudge reports invalid status values", () => {
  const tasks = buildTasks([{ id: "t1", title: "First", status: "pending" }]);
  const msg = buildNudgeMessage(tasks, [{ taskId: "t1", rawValue: "done" }], "/tmp/tasks.md");
  assert.ok(msg.includes("Invalid status values:"));
  assert.ok(msg.includes('t1 had status "done"'));
});

test("nudge mentions valid statuses and blocked fallback", () => {
  const tasks = buildTasks([{ id: "t1", title: "First" }]);
  const msg = buildNudgeMessage(tasks, [], "/tmp/tasks.md");
  assert.ok(msg.includes("pending, in_progress, completed, blocked"));
  assert.ok(msg.includes("blocked"));
});
