import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/runner/run-loop.js";

const CLI_PATH = resolvePath(new URL("../dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: task-cmd-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: task-cmd-work
maxRetries: 1
tasks:
  - id: t1
    title: First
    body: Do thing one.
  - id: t2
    title: Second
    body: Do thing two.
---
Work.
`;

const ASSIGNMENT_LOCKED = `---
schemaVersion: 1
name: task-cmd-locked-work
maxRetries: 1
lockedFields:
  - tasks
tasks:
  - id: t1
    title: Only
---
Locked.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-taskcmd-"));
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), body);
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assignment.md"), body);
}

function writeBundle(baseDir, assignmentBody = ASSIGNMENT, assignmentName = "task-cmd-work") {
  writeAgent(baseDir, "task-cmd-agent", AGENT);
  writeAssignment(baseDir, assignmentName, assignmentBody);
}

async function initRun(baseDir, assignmentName = "task-cmd-work") {
  const loaded = loadAgentConfig("task-cmd-agent", baseDir);
  const loadedAssignment = loadAssignmentConfig(assignmentName, baseDir);
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars: {},
      backend: { id: "mock", invoke: async () => ({}) },
      initialize: true,
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
}

function runCli(args, opts = {}) {
  const stdout = execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout;
}

function runCliExpectFail(args, opts = {}) {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    throw new Error("expected CLI to fail");
  } catch (err) {
    if (err.status === undefined) throw err;
    return {
      status: err.status,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

test("task set: updates status only on initialized run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const out = runCli(["task", "set", outcome.runId, "t1", "--status", "in_progress"], { cwd: dir });
  assert.match(out, /updated t1 \(status=in_progress\)/);

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.status, "in_progress");
  assert.equal(manifest.finalTasks.t1.notes, "");
  assert.equal(manifest.finalTasks.t2.status, "pending");
  assert.equal(manifest.tasksCompleted, 0);

  const planText = readFileSync(manifest.assignmentPath, "utf8");
  assert.match(planText, /<!-- task-id: t1 -->[\s\S]*?\*\*Status:\*\* in_progress/);
});

test("task set: updates notes only", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  runCli(["task", "set", outcome.runId, "t2", "--notes", "Investigation ongoing."], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t2.status, "pending");
  assert.equal(manifest.finalTasks.t2.notes, "Investigation ongoing.");

  const planText = readFileSync(manifest.assignmentPath, "utf8");
  assert.match(planText, /Investigation ongoing\./);
});

test("task set: updates both status and notes; --output-format json returns task snapshot", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const jsonOut = runCli(
    [
      "task",
      "set",
      outcome.runId,
      "t1",
      "--status",
      "completed",
      "--notes",
      "Done.",
      "--output-format",
      "json",
    ],
    { cwd: dir },
  );
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.id, "t1");
  assert.equal(parsed.status, "completed");
  assert.equal(parsed.notes, "Done.");

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.tasksCompleted, 1);
  assert.equal(manifest.tasksTotal, 2);
});

test("task set: rejects unknown task id without touching manifest", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const before = JSON.stringify(readManifest(outcome.workspaceDir));

  const result = runCliExpectFail(["task", "set", outcome.runId, "nope", "--status", "completed"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /task "nope" not found/);

  const after = JSON.stringify(readManifest(outcome.workspaceDir));
  assert.equal(before, after);
});

test("task set: rejects invalid status value", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const result = runCliExpectFail(["task", "set", outcome.runId, "t1", "--status", "almost-done"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /invalid --status/);
});

test("task set: requires at least one of --status / --notes", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const result = runCliExpectFail(["task", "set", outcome.runId, "t1"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /requires at least one of --status \/ --notes/);
});

test("task set: rejects missing positionals", async () => {
  const dir = tempDir();
  const result = runCliExpectFail(["task", "set"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /requires <run-id> <task-id>/);
});

test("task set: rejected while manifest status=running", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  // Patch manifest to running to simulate an in-flight run
  const manifestPath = join(outcome.workspaceDir, "run.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.status = "running";
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);

  const result = runCliExpectFail(["task", "set", outcome.runId, "t1", "--status", "completed"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot mutate tasks on a running run/);
});

test("task set: live assignment.md edits are preserved when CLI touches a different task", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  // Simulate a manual edit to assignment.md for t1 (status in_progress, with notes)
  const planPath = outcome.assignmentPath;
  let plan = readFileSync(planPath, "utf8");
  plan = plan.replace(/(<!-- task-id: t1 -->[\s\S]*?\*\*Status:\*\*) pending/, "$1 in_progress");
  plan = plan.replace(
    /(<!-- task-id: t1 -->[\s\S]*?<!-- notes:start -->\n)(<!-- notes:end -->)/,
    "$1Working on it.\n$2",
  );
  writeFileSync(planPath, plan, "utf8");

  // Now CLI-mutate t2. t1's manual edits should survive.
  runCli(["task", "set", outcome.runId, "t2", "--status", "completed"], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.status, "in_progress");
  assert.equal(manifest.finalTasks.t1.notes, "Working on it.");
  assert.equal(manifest.finalTasks.t2.status, "completed");
  assert.equal(manifest.tasksCompleted, 1);
});

test("task add: appends new task with cli-* id to initialized run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const out = runCli(["task", "add", outcome.runId, "--title", "Third thing"], { cwd: dir });
  assert.match(out, /added task cli-[a-z0-9]+ "Third thing"/);

  const manifest = readManifest(outcome.workspaceDir);
  const ids = Object.keys(manifest.finalTasks);
  assert.equal(ids.length, 3);
  assert.equal(ids[0], "t1");
  assert.equal(ids[1], "t2");
  assert.match(ids[2], /^cli-[a-z0-9]+$/);
  assert.equal(manifest.finalTasks[ids[2]].title, "Third thing");
  assert.equal(manifest.finalTasks[ids[2]].status, "pending");
  assert.equal(manifest.tasksTotal, 3);

  const planText = readFileSync(manifest.assignmentPath, "utf8");
  assert.match(planText, new RegExp(`<!-- task-id: ${ids[2]} -->`));
  assert.match(planText, /## Task 3: Third thing/);
});

test("task add: rejects when `tasks` is locked via assignment lockedFields", async () => {
  const dir = tempDir();
  writeBundle(dir, ASSIGNMENT_LOCKED, "task-cmd-locked-work");
  const outcome = await initRun(dir, "task-cmd-locked-work");

  const result = runCliExpectFail(["task", "add", outcome.runId, "--title", "Extra"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /`tasks` field is locked/);

  // Manifest unchanged
  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(Object.keys(manifest.finalTasks).length, 1);
});

test("task add: requires --title", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const result = runCliExpectFail(["task", "add", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /requires --title/);
});

test("task add: rejects empty title", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const result = runCliExpectFail(["task", "add", outcome.runId, "--title", "   "], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /title cannot be empty/);
});

test("task add: --output-format json returns new task snapshot", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const out = runCli(
    ["task", "add", outcome.runId, "--title", "New one", "--output-format", "json"],
    { cwd: dir },
  );
  const parsed = JSON.parse(out);
  assert.match(parsed.id, /^cli-[a-z0-9]+$/);
  assert.equal(parsed.title, "New one");
  assert.equal(parsed.status, "pending");
});

test("task set: works on a terminal-status run after it has been resolved", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  // Patch manifest to a terminal status (success) to simulate an
  // already-finished run whose task list we now want to amend.
  const manifestPath = join(outcome.workspaceDir, "run.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.status = "success";
  m.endedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);

  runCli(["task", "set", outcome.runId, "t1", "--notes", "Post-hoc annotation"], { cwd: dir });

  const after = readManifest(outcome.workspaceDir);
  assert.equal(after.status, "success");
  assert.equal(after.finalTasks.t1.notes, "Post-hoc annotation");
});

test("task set: rejects status changes on a terminal non-passive run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const manifestPath = join(outcome.workspaceDir, "run.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.status = "success";
  m.endedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);

  const result = runCliExpectFail(["task", "set", outcome.runId, "t1", "--status", "completed"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot change task status on a terminal non-passive run/);
});

test("task add: rejects terminal non-passive runs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const manifestPath = join(outcome.workspaceDir, "run.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.status = "success";
  m.endedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);

  const result = runCliExpectFail(["task", "add", outcome.runId, "--title", "Follow-up"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot add tasks to a terminal non-passive run/);
});

test("task set: rejects manifests whose assignmentPath does not match the workspace", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const manifestPath = join(outcome.workspaceDir, "run.json");
  const m = JSON.parse(readFileSync(manifestPath, "utf8"));
  m.assignmentPath = join(dir, "elsewhere.md");
  writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`);

  const result = runCliExpectFail(["task", "set", outcome.runId, "t1", "--notes", "nope"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /has assignmentPath/);
});

test("task command: missing subcommand prints usage and exits 3", async () => {
  const result = runCliExpectFail(["task"], {});
  assert.equal(result.status, 3);
  assert.match(result.stderr, /task command requires a subcommand/);
});

test("task set: status-only call can then be read back via status --output-format json --field finalTasks", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });

  const out = runCli(
    ["status", outcome.runId, "--output-format", "json", "--field", "finalTasks"],
    { cwd: dir },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.finalTasks.t1.status, "completed");
  assert.equal(parsed.finalTasks.t2.status, "pending");
});
