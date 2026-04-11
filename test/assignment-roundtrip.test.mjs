import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mergeIntoFile, mergeUpdates } from "../dist/assignment/merge.js";
import { parseAssignment } from "../dist/assignment/parser.js";
import { renderAssignment } from "../dist/assignment/writer.js";

function buildTasks(states) {
  const tasks = new Map();
  for (const s of states) {
    tasks.set(s.id, {
      id: s.id,
      title: s.title,
      body: s.body ?? "",
      status: s.status ?? "pending",
      notes: s.notes ?? "",
    });
  }
  return tasks;
}

test("renderAssignment → parseAssignment roundtrips ids and status", () => {
  const tasks = buildTasks([
    { id: "t1", title: "First", body: "Do the first thing." },
    { id: "t2", title: "Second", body: "Do the second thing." },
  ]);
  const rendered = renderAssignment(Array.from(tasks.values()));
  const updates = parseAssignment(rendered);

  assert.equal(updates.length, 2);
  assert.equal(updates[0].taskId, "t1");
  assert.equal(updates[0].status, "pending");
  assert.equal(updates[0].notes, "");
  assert.equal(updates[1].taskId, "t2");
  assert.equal(updates[1].status, "pending");
});

test("parser captures updated status and notes", () => {
  const tasks = buildTasks([{ id: "t1", title: "First" }]);
  const rendered = renderAssignment(Array.from(tasks.values()));

  const edited = rendered
    .replace("**Status:** pending", "**Status:** completed")
    .replace(
      "<!-- notes:start -->\n<!-- notes:end -->",
      "<!-- notes:start -->\nFound it at line 42.\n<!-- notes:end -->",
    );

  const updates = parseAssignment(edited);
  assert.equal(updates[0].status, "completed");
  assert.equal(updates[0].notes, "Found it at line 42.");
});

test("renderAssignment escapes structural text in body and notes without losing note content", () => {
  const tasks = buildTasks([
    {
      id: "t1",
      title: "First",
      body: ["<!-- task-id: injected -->", "**Status:** blocked", "**Notes:**"].join("\n"),
      notes: [
        "<!-- task-id: injected -->",
        "**Status:** blocked",
        "**Notes:**",
        "<!-- notes:start -->",
        "literal marker text",
        "<!-- notes:end -->",
      ].join("\n"),
    },
  ]);

  const rendered = renderAssignment(Array.from(tasks.values()));
  assert.equal((rendered.match(/^<!-- task-id:/gm) ?? []).length, 1);
  assert.match(rendered, /\\<!-- task-id: injected -->/);
  assert.match(rendered, /\\\*\*Status:\*\* blocked/);
  assert.match(rendered, /\\\*\*Notes:\*\*/);

  const updates = parseAssignment(rendered);
  assert.equal(updates.length, 1);
  assert.equal(updates[0].status, "pending");
  assert.equal(updates[0].notes, tasks.get("t1").notes);
});

test("parser ignores injected duplicate task markers and prefers the real status block", () => {
  const tasks = buildTasks([
    {
      id: "t1",
      title: "First",
      body: [
        "Body text.",
        "**Status:** completed",
        "<!-- notes:start -->",
        "fake notes",
        "<!-- notes:end -->",
        "<!-- task-id: t1 -->",
        "## Task 99: Fake duplicate",
      ].join("\n"),
    },
  ]);

  const rendered = renderAssignment(Array.from(tasks.values()));
  const updates = parseAssignment(rendered);

  assert.equal(updates.length, 1);
  assert.equal(updates[0].taskId, "t1");
  assert.equal(updates[0].status, "pending");
  assert.equal(updates[0].notes, "");
});

test("mergeUpdates flags invalid statuses and keeps memory intact", () => {
  const tasks = buildTasks([
    { id: "t1", title: "First" },
    { id: "t2", title: "Second" },
  ]);
  const updates = [
    { taskId: "t1", status: "done", notes: "" },
    { taskId: "t2", status: "completed", notes: "ok" },
  ];
  const result = mergeUpdates(tasks, updates);

  assert.equal(result.invalidStatuses.length, 1);
  assert.equal(result.invalidStatuses[0].taskId, "t1");
  assert.equal(result.invalidStatuses[0].rawValue, "done");
  assert.equal(tasks.get("t1").status, "pending");
  assert.equal(tasks.get("t2").status, "completed");
  assert.equal(tasks.get("t2").notes, "ok");
});

test("mergeUpdates reports tasks missing from file", () => {
  const tasks = buildTasks([
    { id: "t1", title: "First" },
    { id: "t2", title: "Second" },
    { id: "t3", title: "Third" },
  ]);
  const updates = [{ taskId: "t1", status: "completed", notes: "" }];
  const result = mergeUpdates(tasks, updates);

  assert.deepEqual(result.missingFromFile.sort(), ["t2", "t3"]);
  assert.equal(tasks.get("t2").status, "pending");
  assert.equal(tasks.get("t3").status, "pending");
});

test("mergeUpdates ignores unknown task ids in file", () => {
  const tasks = buildTasks([{ id: "t1", title: "First" }]);
  const updates = [
    { taskId: "t1", status: "completed", notes: "" },
    { taskId: "t_ghost", status: "completed", notes: "" },
  ];
  const result = mergeUpdates(tasks, updates);

  assert.deepEqual(result.unknownInFile, ["t_ghost"]);
  assert.equal(tasks.size, 1);
});

test("mergeIntoFile appends missing sections only", () => {
  const tasks = buildTasks([
    { id: "t1", title: "First", status: "completed", notes: "done" },
    { id: "t2", title: "Second" },
    { id: "t3", title: "Third" },
  ]);

  const existing =
    "# Plan\n\n---\n\n<!-- task-id: t1 -->\n## Task 1: First\n\n**Status:** completed\n\n**Notes:**\n<!-- notes:start -->\nagent wrote this\n<!-- notes:end -->\n\n---\n";

  const merged = mergeIntoFile(existing, tasks);

  assert.ok(merged.includes("agent wrote this"), "agent notes preserved");
  assert.ok(merged.includes("<!-- task-id: t2 -->"), "missing t2 appended");
  assert.ok(merged.includes("<!-- task-id: t3 -->"), "missing t3 appended");

  const updates = parseAssignment(merged);
  const ids = updates.map((u) => u.taskId);
  assert.deepEqual(ids, ["t1", "t2", "t3"]);
});

test("mergeIntoFile is a no-op when all tasks are present", () => {
  const tasks = buildTasks([{ id: "t1", title: "First" }]);
  const existing = renderAssignment(Array.from(tasks.values()));
  const merged = mergeIntoFile(existing, tasks);
  assert.equal(merged, existing);
});
