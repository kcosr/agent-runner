import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { sharedRuntimeEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

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

const ASSIGNMENT_CLI_MODE = `---
schemaVersion: 1
name: task-cmd-cli-work
taskMode: cli
maxRetries: 1
tasks:
  - id: t1
    title: First
    body: Do thing one.
  - id: t2
    title: Second
    body: Do thing two.
---
Work through the CLI.
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
  return withSharedRuntimeEnv(baseDir, async () => {
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
  });
}

function runCli(args, opts = {}) {
  const stdout = execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  return stdout;
}

function runCliExpectFail(args, opts = {}) {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
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

function readCapabilities(runId, cwd) {
  return JSON.parse(
    runCli(["status", runId, "--output-format", "json", "--field", "capabilities"], { cwd }),
  ).capabilities;
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = readManifest(workspaceDir);
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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

test("task set: rejected while manifest status=running in taskMode=file", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  // Patch manifest to running to simulate an in-flight run
  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "file";
  });

  const result = runCliExpectFail(["task", "set", outcome.runId, "t1", "--status", "completed"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /running file-mode run/);
  assert.deepEqual(readCapabilities(outcome.runId, dir), {
    canArchive: false,
    canUnarchive: false,
    canResume: false,
    taskMutation: {
      canSetStatus: false,
      canEditNotes: false,
      canAdd: false,
    },
  });
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

test("task set: allowed while manifest status=running in taskMode=cli", async () => {
  const dir = tempDir();
  writeBundle(dir, ASSIGNMENT_CLI_MODE, "task-cmd-cli-work");
  const outcome = await initRun(dir, "task-cmd-cli-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "cli";
  });

  const out = runCli(["task", "set", outcome.runId, "t1", "--status", "in_progress"], { cwd: dir });
  assert.match(out, /updated t1 \(status=in_progress\)/);

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "running");
  assert.equal(manifest.finalTasks.t1.status, "in_progress");
  assert.deepEqual(readCapabilities(outcome.runId, dir), {
    canArchive: false,
    canUnarchive: false,
    canResume: false,
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: false,
    },
  });
});

test("task append-notes: allowed while manifest status=running in taskMode=cli", async () => {
  const dir = tempDir();
  writeBundle(dir, ASSIGNMENT_CLI_MODE, "task-cmd-cli-work");
  const outcome = await initRun(dir, "task-cmd-cli-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "cli";
  });

  const out = runCli(["task", "append-notes", outcome.runId, "t2", "--text", "Captured detail"], {
    cwd: dir,
  });
  assert.match(out, /updated t2 \(status=pending\)/);

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "running");
  assert.equal(manifest.finalTasks.t2.notes, "Captured detail");
  const planText = readFileSync(outcome.assignmentPath, "utf8");
  assert.match(planText, /Captured detail/);
});

test("task append-notes: rejected while manifest status=running in taskMode=file", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "file";
  });

  const result = runCliExpectFail(
    ["task", "append-notes", outcome.runId, "t1", "--text", "blocked"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /running file-mode run/);
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

test("task add: rejects multiline title", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const result = runCliExpectFail(["task", "add", outcome.runId, "--title", "Line 1\nLine 2"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /title must be a single line/);
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

test("run reset: restores the original initialized task snapshot after task mutations", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const originalPrompt = outcome.manifest.pendingPrompt;

  runCli(
    ["task", "set", outcome.runId, "t1", "--status", "in_progress", "--notes", "Working on it"],
    { cwd: dir },
  );
  const added = JSON.parse(
    runCli(["task", "add", outcome.runId, "--title", "Temporary", "--output-format", "json"], {
      cwd: dir,
    }),
  );

  const out = runCli(["run", "reset", outcome.runId], { cwd: dir });
  assert.match(out, new RegExp(`reset run ${outcome.runId} to initialized state`));

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "initialized");
  assert.equal(manifest.pendingPrompt, originalPrompt);
  assert.deepEqual(Object.keys(manifest.finalTasks), ["t1", "t2"]);
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.finalTasks.t1.notes, "");
  assert.equal(manifest.tasksCompleted, 0);
  assert.equal(manifest.tasksTotal, 2);
  assert.equal(manifest.sessionCount, 0);
  assert.deepEqual(manifest.sessions, []);
  assert.deepEqual(manifest.attemptRecords, []);

  const planText = readFileSync(outcome.assignmentPath, "utf8");
  assert.doesNotMatch(planText, new RegExp(`<!-- task-id: ${added.id} -->`));
  assert.match(planText, /<!-- task-id: t1 -->[\s\S]*?\*\*Status:\*\* pending/);
});

test("run reset: json output restores initialized state and removes attempt artifacts", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.endedAt = "2026-04-12T15:00:00.000Z";
    manifest.exitCode = 0;
    manifest.attempts = 2;
    manifest.maxAttempts = 9;
    manifest.model = "override-model";
    manifest.effort = "max";
    manifest.name = "override session";
    manifest.unrestricted = true;
    manifest.timeoutSec = 42;
    manifest.backendSessionId = "sess-after-run";
    manifest.pendingPrompt = null;
    manifest.finalTasks.t1.status = "completed";
    manifest.finalTasks.t1.notes = "Done.";
    manifest.tasksCompleted = 1;
    manifest.sessionCount = 2;
    manifest.sessions = [{ sessionIndex: 0 }, { sessionIndex: 1 }];
    manifest.attemptRecords = [{ attempt: 1 }, { attempt: 2 }];
  });
  mkdirSync(join(outcome.workspaceDir, "attempts"), { recursive: true });
  writeFileSync(join(outcome.workspaceDir, "attempts", "01.json"), "{}\n");

  const out = runCli(["run", "reset", outcome.runId, "--output-format", "json"], { cwd: dir });
  assert.deepEqual(JSON.parse(out), { runId: outcome.runId, status: "initialized" });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "initialized");
  assert.equal(manifest.endedAt, null);
  assert.equal(manifest.exitCode, null);
  assert.equal(manifest.attempts, 0);
  assert.equal(manifest.maxAttempts, 2);
  assert.equal(manifest.model, "claude-sonnet-4-6");
  assert.equal(manifest.effort, null);
  assert.equal(manifest.name, null);
  assert.equal(manifest.unrestricted, false);
  assert.equal(manifest.timeoutSec, 3600);
  assert.equal(manifest.backendSessionId, null);
  assert.ok(manifest.pendingPrompt);
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.finalTasks.t1.notes, "");
  assert.equal(manifest.sessionCount, 0);
  assert.deepEqual(manifest.sessions, []);
  assert.deepEqual(manifest.attemptRecords, []);
  assert.equal(existsSync(join(outcome.workspaceDir, "attempts")), false);
});

test("run reset: rejects a running file-mode run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "file";
  });

  const result = runCliExpectFail(["run", "reset", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot reset a running run/);
});

test("run reset: rejects a running cli-mode run", async () => {
  const dir = tempDir();
  writeBundle(dir, ASSIGNMENT_CLI_MODE, "task-cmd-cli-work");
  const outcome = await initRun(dir, "task-cmd-cli-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "cli";
  });

  const result = runCliExpectFail(["run", "reset", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot reset a running run/);
});

test("task list: text output follows manifest task order", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const out = runCli(["task", "list", outcome.runId], { cwd: dir });
  assert.equal(out, "[pending] t1 - First\n[pending] t2 - Second\n");
});

test("task list: json output returns task snapshots in order", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const out = runCli(["task", "list", outcome.runId, "--output-format", "json"], { cwd: dir });
  const parsed = JSON.parse(out);
  assert.deepEqual(
    parsed.map((task) => task.id),
    ["t1", "t2"],
  );
  assert.equal(parsed[0].body, "Do thing one.");
  assert.equal(parsed[1].notes, "");
});

test("task show: text and json outputs match the task snapshot", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  runCli(["task", "set", outcome.runId, "t2", "--status", "in_progress", "--notes", "Working"], {
    cwd: dir,
  });

  const textOut = runCli(["task", "show", outcome.runId, "t2"], { cwd: dir });
  assert.match(textOut, /^id: t2$/m);
  assert.match(textOut, /^title: Second$/m);
  assert.match(textOut, /^status: in_progress$/m);
  assert.match(textOut, /body:\nDo thing two\.\nnotes:\nWorking\n$/);

  const jsonOut = runCli(["task", "show", outcome.runId, "t2", "--output-format", "json"], {
    cwd: dir,
  });
  const parsed = JSON.parse(jsonOut);
  assert.equal(parsed.id, "t2");
  assert.equal(parsed.status, "in_progress");
  assert.equal(parsed.notes, "Working");
});

test("task show: rejects unknown task ids", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const result = runCliExpectFail(["task", "show", outcome.runId, "missing"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /task "missing" not found/);
});

test("task append-notes: appends with deterministic newline joining", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  runCli(["task", "append-notes", outcome.runId, "t1", "--text", "First line"], { cwd: dir });
  runCli(["task", "append-notes", outcome.runId, "t1", "--text", "  Second line  "], {
    cwd: dir,
  });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.notes, "First line\nSecond line");
});

test("task append-notes: rejects missing or empty --text", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const missing = runCliExpectFail(["task", "append-notes", outcome.runId, "t1"], { cwd: dir });
  assert.equal(missing.status, 3);
  assert.match(missing.stderr, /requires --text/);

  const empty = runCliExpectFail(["task", "append-notes", outcome.runId, "t1", "--text", "   "], {
    cwd: dir,
  });
  assert.equal(empty.status, 3);
  assert.match(empty.stderr, /--text cannot be empty/);
});

test("task add: accepts --body and persists it", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const out = runCli(
    [
      "task",
      "add",
      outcome.runId,
      "--title",
      "Docs alignment",
      "--body",
      "Update README and docs/design command tables.",
      "--output-format",
      "json",
    ],
    { cwd: dir },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.title, "Docs alignment");
  assert.equal(parsed.body, "Update README and docs/design command tables.");

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(
    manifest.finalTasks[parsed.id].body,
    "Update README and docs/design command tables.",
  );
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

test("task set: notes-only update on terminal non-passive run ignores workspace status drift", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  const manifestPath = join(outcome.workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  manifest.status = "success";
  manifest.endedAt = new Date().toISOString();
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  let plan = readFileSync(outcome.assignmentPath, "utf8");
  plan = plan.replace(/(<!-- task-id: t2 -->[\s\S]*?\*\*Status:\*\*) pending/, "$1 completed");
  writeFileSync(outcome.assignmentPath, plan, "utf8");

  runCli(["task", "set", outcome.runId, "t1", "--notes", "Post-hoc annotation"], { cwd: dir });

  const after = readManifest(outcome.workspaceDir);
  assert.equal(after.status, "success");
  assert.equal(after.finalTasks.t1.notes, "Post-hoc annotation");
  assert.equal(after.finalTasks.t1.status, "pending");
  assert.equal(after.finalTasks.t2.status, "pending");

  const persistedPlan = readFileSync(outcome.assignmentPath, "utf8");
  assert.match(persistedPlan, /<!-- task-id: t2 -->[\s\S]*?\*\*Status:\*\* pending/);
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
  assert.deepEqual(readCapabilities(outcome.runId, dir), {
    canArchive: true,
    canUnarchive: false,
    canResume: true,
    taskMutation: {
      canSetStatus: false,
      canEditNotes: true,
      canAdd: false,
    },
  });
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

test("task add: remains rejected while a cli-mode run is running", async () => {
  const dir = tempDir();
  writeBundle(dir, ASSIGNMENT_CLI_MODE, "task-cmd-cli-work");
  const outcome = await initRun(dir, "task-cmd-cli-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "cli";
  });

  const result = runCliExpectFail(["task", "add", outcome.runId, "--title", "Follow-up"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /task add remains rejected while a run is in-flight/);
});

test("task list/show: running cli-mode reads ignore assignment.md drift", async () => {
  const dir = tempDir();
  writeBundle(dir, ASSIGNMENT_CLI_MODE, "task-cmd-cli-work");
  const outcome = await initRun(dir, "task-cmd-cli-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "cli";
    manifest.finalTasks.t1.status = "in_progress";
    manifest.finalTasks.t1.notes = "Canonical note";
  });

  let plan = readFileSync(outcome.assignmentPath, "utf8");
  plan = plan.replace(/(<!-- task-id: t1 -->[\s\S]*?\*\*Status:\*\*) pending/, "$1 completed");
  plan = plan.replace(
    /(<!-- task-id: t1 -->[\s\S]*?<!-- notes:start -->\n)(<!-- notes:end -->)/,
    "$1Drifted note\n$2",
  );
  writeFileSync(outcome.assignmentPath, plan, "utf8");

  const listOut = runCli(["task", "list", outcome.runId], { cwd: dir });
  assert.match(listOut, /\[in_progress\] t1 - First/);
  assert.doesNotMatch(listOut, /\[completed\] t1 - First/);

  const showOut = runCli(["task", "show", outcome.runId, "t1"], { cwd: dir });
  assert.match(showOut, /^status: in_progress$/m);
  assert.match(showOut, /notes:\nCanonical note\n$/);
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

test("task set: status-only call can then be read back via status --output-format json --field tasks", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });

  const out = runCli(["status", outcome.runId, "--output-format", "json", "--field", "tasks"], {
    cwd: dir,
  });
  const parsed = JSON.parse(out);
  assert.equal(parsed.tasks[0].status, "completed");
  assert.equal(parsed.tasks[1].status, "pending");
});
