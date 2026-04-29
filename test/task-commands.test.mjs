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

function writeAssignmentHook(baseDir, assignmentName, relativePath, body) {
  const dir = join(baseDir, "assignments", assignmentName, "hooks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, relativePath), body);
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

function assertTimestampAdvanced(before, after, label) {
  assert.ok(after > before, `${label}: expected ${after} to be after ${before}`);
}

function readCapabilities(runId, cwd) {
  return JSON.parse(
    runCli(["run", "status", runId, "--output-format", "json", "--field", "capabilities"], {
      cwd,
    }),
  ).capabilities;
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = readManifest(workspaceDir);
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function taskGuardedAssignment({ requireAny, omitWith } = {}) {
  return `---
schemaVersion: 1
name: task-cmd-work
maxRetries: 1
tasks:
  - id: peer_review
    title: Peer review
    body: Wait for reviewer child runs.
    hooks:
      - builtin: require-children-success
${
  omitWith === true
    ? ""
    : `        with:
          requireAny: ${requireAny === true ? "true" : "false"}`
}
  - id: ship
    title: Ship
    body: Ship the change.
---
Work.
`;
}

const TASK_SCOPED_CONTRADICTION_ASSIGNMENT = `---
schemaVersion: 1
name: task-cmd-work
maxRetries: 1
tasks:
  - id: peer_review
    title: Peer review
    body: Wait for reviewer child runs.
    hooks:
      - builtin: require-children-success
        when:
          taskId: ship
  - id: ship
    title: Ship
    body: Ship the change.
---
Work.
`;

test("task set: updates status only on initialized run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const before = readManifest(outcome.workspaceDir).updatedAt;

  const out = runCli(["task", "set", outcome.runId, "t1", "--status", "in_progress"], { cwd: dir });
  assert.match(out, /updated t1 \(status=in_progress\)/);

  const manifest = readManifest(outcome.workspaceDir);
  assertTimestampAdvanced(before, manifest.updatedAt, "task set updatedAt");
  assert.equal(manifest.finalTasks.t1.status, "in_progress");
  assert.equal(manifest.finalTasks.t1.notes, "");
  assert.equal(manifest.finalTasks.t2.status, "pending");
  assert.equal(manifest.tasksCompleted, 0);
  assert.ok(existsSync(join(outcome.workspaceDir, "assignment-seed.md")));
});

test("task set: updates notes only", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  runCli(["task", "set", outcome.runId, "t2", "--notes", "Investigation ongoing."], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t2.status, "pending");
  assert.equal(manifest.finalTasks.t2.notes, "Investigation ongoing.");
  assert.ok(existsSync(join(outcome.workspaceDir, "assignment-seed.md")));
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

test("task set: allowed while manifest status=running", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
  });

  const out = runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  assert.match(out, /updated t1 \(status=completed\)/);
  assert.deepEqual(readCapabilities(outcome.runId, dir), {
    canArchive: false,
    canUnarchive: false,
    canReset: false,
    canDelete: false,
    canReady: false,
    canResume: false,
    canAbort: false,
    abortReason: "not_active_in_daemon",
    canReconfigure: false,
    reconfigureReason: "not_initialized",
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: false,
    },
  });
});

test("task set: taskTransition path hook rejects completion, rolls back task state, and applies note mutation", async () => {
  const dir = tempDir();
  writeBundle(
    dir,
    `---
schemaVersion: 1
name: task-cmd-work
maxRetries: 1
hooks:
  taskTransition:
    - path: ./hooks/guard.mts
      when:
        toStatus: ["completed"]
tasks:
  - id: t1
    title: First
    body: Do thing one.
---
Work.
`,
  );
  writeAssignmentHook(
    dir,
    "task-cmd-work",
    "guard.mts",
    `export default {
  name: "guard",
  taskTransition(ctx) {
    if (ctx.transition.to.notes.includes("OK")) {
      return { accept: true };
    }
    return {
      accept: false,
      reason: "notes must include OK",
      mutate: { note: "completion blocked" },
    };
  },
};
`,
  );
  const outcome = await initRun(dir);

  const rejected = runCliExpectFail(
    ["task", "set", outcome.runId, "t1", "--status", "completed", "--notes", "not yet"],
    { cwd: dir },
  );
  assert.equal(rejected.status, 3);
  assert.match(rejected.stderr, /notes must include OK/);

  let manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.finalTasks.t1.notes, "");
  assert.equal(manifest.note, "completion blocked");

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed", "--notes", "OK to ship"], {
    cwd: dir,
  });
  manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.status, "completed");
  assert.equal(manifest.finalTasks.t1.notes, "OK to ship");
});

test("task set: native task-transition when matching composes task id, source, and status filters", async () => {
  const dir = tempDir();
  writeBundle(
    dir,
    `---
schemaVersion: 1
name: task-cmd-work
maxRetries: 1
hooks:
  taskTransition:
    - path: ./hooks/native-when-guard.mts
      when:
        taskId: peer_review
        source: ["task-set"]
        fromStatus: ["pending"]
        toStatus: ["completed"]
tasks:
  - id: peer_review
    title: Peer review
    body: Wait for reviewer child runs.
  - id: ship
    title: Ship
    body: Ship the change.
---
Work.
`,
  );
  writeAssignmentHook(
    dir,
    "task-cmd-work",
    "native-when-guard.mts",
    `export default {
  name: "native-when-guard",
  taskTransition() {
    return { accept: false, reason: "peer review completion is guarded" };
  },
};
`,
  );
  const outcome = await initRun(dir);

  runCli(["task", "append-notes", outcome.runId, "peer_review", "--text", "capture context"], {
    cwd: dir,
  });
  runCli(["task", "set", outcome.runId, "ship", "--status", "completed"], { cwd: dir });

  const rejected = runCliExpectFail(
    ["task", "set", outcome.runId, "peer_review", "--status", "completed"],
    { cwd: dir },
  );
  assert.equal(rejected.status, 3);
  assert.match(rejected.stderr, /peer review completion is guarded/);

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.ship.status, "completed");
  assert.equal(manifest.finalTasks.peer_review.status, "pending");
  assert.equal(manifest.finalTasks.peer_review.notes, "capture context");
});

test("task set: task-local hooks run before assignment-level hooks and short-circuit on first rejection", async () => {
  const dir = tempDir();
  writeBundle(
    dir,
    `---
schemaVersion: 1
name: task-cmd-work
maxRetries: 1
hooks:
  taskTransition:
    - path: ./hooks/assignment-guard.mts
tasks:
  - id: t1
    title: First
    hooks:
      - path: ./hooks/local-guard.mts
  - id: t2
    title: Second
---
Work.
`,
  );
  writeAssignmentHook(
    dir,
    "task-cmd-work",
    "local-guard.mts",
    `export default {
  name: "local-guard",
  taskTransition() {
    return {
      accept: false,
      reason: "local guard blocked completion",
      mutate: { note: "local guard ran" },
    };
  },
};
`,
  );
  writeAssignmentHook(
    dir,
    "task-cmd-work",
    "assignment-guard.mts",
    `export default {
  name: "assignment-guard",
  taskTransition() {
    return {
      accept: false,
      reason: "assignment guard blocked completion",
      mutate: { note: "assignment guard ran" },
    };
  },
};
`,
  );
  const outcome = await initRun(dir);

  const firstRejected = runCliExpectFail(
    ["task", "set", outcome.runId, "t1", "--status", "completed"],
    { cwd: dir },
  );
  assert.equal(firstRejected.status, 3);
  assert.match(firstRejected.stderr, /local guard blocked completion/);

  let manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.note, "local guard ran");

  const secondRejected = runCliExpectFail(
    ["task", "set", outcome.runId, "t2", "--status", "completed"],
    { cwd: dir },
  );
  assert.equal(secondRejected.status, 3);
  assert.match(secondRejected.stderr, /assignment guard blocked completion/);

  manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t2.status, "pending");
  assert.equal(manifest.note, "assignment guard ran");
});

test("task set: require-children-success allows completion when no direct children exist by default", async () => {
  const dir = tempDir();
  writeBundle(dir, taskGuardedAssignment());
  const outcome = await initRun(dir);

  runCli(["task", "set", outcome.runId, "peer_review", "--status", "completed"], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.peer_review.status, "completed");
});

test("task set: require-children-success defaults requireAny to false when config is omitted", async () => {
  const dir = tempDir();
  writeBundle(dir, taskGuardedAssignment({ omitWith: true }));
  const outcome = await initRun(dir);

  runCli(["task", "set", outcome.runId, "peer_review", "--status", "completed"], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.peer_review.status, "completed");
});

test("task set: require-children-success rejects completion when requireAny is true and no direct children exist", async () => {
  const dir = tempDir();
  writeBundle(dir, taskGuardedAssignment({ requireAny: true }));
  const outcome = await initRun(dir);

  const rejected = runCliExpectFail(
    ["task", "set", outcome.runId, "peer_review", "--status", "completed"],
    { cwd: dir },
  );
  assert.equal(rejected.status, 3);
  assert.match(rejected.stderr, /no direct child runs exist yet/);

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.peer_review.status, "pending");
});

test("task-local hooks reject cross-task when.taskId selectors during resolution", async () => {
  const dir = tempDir();
  writeBundle(dir, TASK_SCOPED_CONTRADICTION_ASSIGNMENT);

  await assert.rejects(
    initRun(dir),
    /task hook taskTransition\[0\] for task "peer_review" cannot target when\.taskId "ship"/,
  );
});

test("task set: require-children-success ignores unrelated task ids", async () => {
  const dir = tempDir();
  writeBundle(dir, taskGuardedAssignment());
  const outcome = await initRun(dir);
  const child = await initRun(dir);
  patchManifest(child.workspaceDir, (manifest) => {
    manifest.parentRunId = outcome.runId;
    manifest.resetSeed.parentRunId = outcome.runId;
    manifest.status = "running";
  });

  runCli(["task", "set", outcome.runId, "ship", "--status", "completed"], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.ship.status, "completed");
});

test("task set: require-children-success rejects completion while a direct child is not successful", async () => {
  const dir = tempDir();
  writeBundle(dir, taskGuardedAssignment());
  const outcome = await initRun(dir);
  const child = await initRun(dir);
  patchManifest(child.workspaceDir, (manifest) => {
    manifest.parentRunId = outcome.runId;
    manifest.resetSeed.parentRunId = outcome.runId;
    manifest.status = "running";
  });

  const rejected = runCliExpectFail(
    ["task", "set", outcome.runId, "peer_review", "--status", "completed"],
    { cwd: dir },
  );
  assert.equal(rejected.status, 3);
  assert.match(rejected.stderr, new RegExp(`${child.runId} \\(running`));

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.peer_review.status, "pending");
});

test("task set: require-children-success allows completion once all direct children succeed", async () => {
  const dir = tempDir();
  writeBundle(dir, taskGuardedAssignment({ requireAny: true }));
  const outcome = await initRun(dir);
  const child = await initRun(dir);
  patchManifest(child.workspaceDir, (manifest) => {
    manifest.parentRunId = outcome.runId;
    manifest.resetSeed.parentRunId = outcome.runId;
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = new Date().toISOString();
  });

  runCli(["task", "set", outcome.runId, "peer_review", "--status", "completed"], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.peer_review.status, "completed");
});

test("task set: require-children-success only checks direct children, not grandchildren", async () => {
  const dir = tempDir();
  writeBundle(dir, taskGuardedAssignment({ requireAny: true }));
  const outcome = await initRun(dir);
  const child = await initRun(dir);
  patchManifest(child.workspaceDir, (manifest) => {
    manifest.parentRunId = outcome.runId;
    manifest.resetSeed.parentRunId = outcome.runId;
    manifest.status = "success";
    manifest.exitCode = 0;
    manifest.endedAt = new Date().toISOString();
  });
  const grandchild = await initRun(dir);
  patchManifest(grandchild.workspaceDir, (manifest) => {
    manifest.parentRunId = child.runId;
    manifest.resetSeed.parentRunId = child.runId;
    manifest.status = "running";
  });

  runCli(["task", "set", outcome.runId, "peer_review", "--status", "completed"], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.peer_review.status, "completed");
});

test("task set: preserves existing manifest task state when CLI touches a different task", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.finalTasks.t1.status = "in_progress";
    manifest.finalTasks.t1.notes = "Working on it.";
  });

  runCli(["task", "set", outcome.runId, "t2", "--status", "completed"], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.finalTasks.t1.status, "in_progress");
  assert.equal(manifest.finalTasks.t1.notes, "Working on it.");
  assert.equal(manifest.finalTasks.t2.status, "completed");
  assert.equal(manifest.tasksCompleted, 1);
});

test("task append-notes: allowed while manifest status=running", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const before = readManifest(outcome.workspaceDir).updatedAt;

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
  });
  const runningUpdatedAt = readManifest(outcome.workspaceDir).updatedAt;

  const out = runCli(["task", "append-notes", outcome.runId, "t2", "--text", "Captured detail"], {
    cwd: dir,
  });
  assert.match(out, /updated t2 \(status=pending\)/);

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(runningUpdatedAt, before);
  assertTimestampAdvanced(runningUpdatedAt, manifest.updatedAt, "task append-notes updatedAt");
  assert.equal(manifest.status, "running");
  assert.equal(manifest.finalTasks.t2.notes, "Captured detail");
  assert.deepEqual(readCapabilities(outcome.runId, dir), {
    canArchive: false,
    canUnarchive: false,
    canReset: false,
    canDelete: false,
    canReady: false,
    canResume: false,
    canAbort: false,
    abortReason: "not_active_in_daemon",
    canReconfigure: false,
    reconfigureReason: "not_initialized",
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: false,
    },
  });
});

test("task add: appends new task with cli-* id to initialized run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const before = readManifest(outcome.workspaceDir).updatedAt;

  const out = runCli(["task", "add", outcome.runId, "--title", "Third thing"], { cwd: dir });
  assert.match(out, /added task cli-[a-z0-9]+ "Third thing"/);

  const manifest = readManifest(outcome.workspaceDir);
  assertTimestampAdvanced(before, manifest.updatedAt, "task add updatedAt");
  const ids = Object.keys(manifest.finalTasks);
  assert.equal(ids.length, 3);
  assert.equal(ids[0], "t1");
  assert.equal(ids[1], "t2");
  assert.match(ids[2], /^cli-[a-z0-9]+$/);
  assert.equal(manifest.finalTasks[ids[2]].title, "Third thing");
  assert.equal(manifest.finalTasks[ids[2]].status, "pending");
  assert.equal(manifest.tasksTotal, 3);
  assert.ok(existsSync(join(outcome.workspaceDir, "assignment-seed.md")));
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
  const originalPrompt = outcome.manifest.brief;

  runCli(
    ["task", "set", outcome.runId, "t1", "--status", "in_progress", "--notes", "Working on it"],
    { cwd: dir },
  );
  const added = JSON.parse(
    runCli(["task", "add", outcome.runId, "--title", "Temporary", "--output-format", "json"], {
      cwd: dir,
    }),
  );
  const beforeReset = readManifest(outcome.workspaceDir).updatedAt;

  const out = runCli(["run", "reset", outcome.runId], { cwd: dir });
  assert.match(out, new RegExp(`reset run ${outcome.runId} to initialized state`));

  const manifest = readManifest(outcome.workspaceDir);
  assertTimestampAdvanced(beforeReset, manifest.updatedAt, "run reset updatedAt");
  assert.equal(manifest.status, "initialized");
  assert.equal(manifest.brief, originalPrompt);
  assert.deepEqual(Object.keys(manifest.finalTasks), ["t1", "t2"]);
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.finalTasks.t1.notes, "");
  assert.equal(manifest.tasksCompleted, 0);
  assert.equal(manifest.tasksTotal, 2);
  assert.equal(manifest.totalSessionCount, 0);
  assert.deepEqual(manifest.sessions, []);
  assert.deepEqual(manifest.attemptRecords, []);

  assert.ok(existsSync(join(outcome.workspaceDir, "assignment-seed.md")));
});

test("run reset: json output restores initialized state and removes attempt artifacts", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.endedAt = "2026-04-12T15:00:00.000Z";
    manifest.exitCode = 0;
    manifest.totalAttemptCount = 2;
    manifest.maxAttemptsPerSession = 9;
    manifest.model = "override-model";
    manifest.effort = "max";
    manifest.name = "override session";
    manifest.unrestricted = true;
    manifest.timeoutSec = 42;
    manifest.backendSessionId = "sess-after-run";
    manifest.finalTasks.t1.status = "completed";
    manifest.finalTasks.t1.notes = "Done.";
    manifest.tasksCompleted = 1;
    manifest.totalSessionCount = 1;
    manifest.sessions = [
      {
        sessionIndex: 0,
        startedAt: "2026-04-12T14:00:00.000Z",
        endedAt: "2026-04-12T15:00:00.000Z",
        status: "success",
        exitCode: 0,
        message: null,
        brief: manifest.brief,
        firstAttemptNumber: 1,
        lastAttemptNumber: 2,
        maxAttemptsPerSession: 9,
        backendSessionIdAtStart: null,
        backendSessionIdAtEnd: "sess-after-run",
      },
    ];
    manifest.attemptRecords = [
      {
        attemptNumber: 1,
        sessionIndex: 0,
        attemptIndexInSession: 0,
        startedAt: "2026-04-12T14:00:00.000Z",
        endedAt: "2026-04-12T14:30:00.000Z",
        prompt: manifest.brief,
        sessionIdAtStart: null,
        sessionIdCaptured: "sess-after-run",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "attempt 1",
        logPath: "attempts/01.json",
        invalidStatuses: [],
      },
      {
        attemptNumber: 2,
        sessionIndex: 0,
        attemptIndexInSession: 1,
        startedAt: "2026-04-12T14:30:00.000Z",
        endedAt: "2026-04-12T15:00:00.000Z",
        prompt: "retry",
        sessionIdAtStart: "sess-after-run",
        sessionIdCaptured: "sess-after-run",
        exitCode: 0,
        signal: null,
        timedOut: false,
        transcript: "attempt 2",
        logPath: "attempts/02.json",
        invalidStatuses: [],
      },
    ];
  });
  const beforeReset = readManifest(outcome.workspaceDir).updatedAt;
  mkdirSync(join(outcome.workspaceDir, "attempts"), { recursive: true });
  writeFileSync(
    join(outcome.workspaceDir, "attempts", "01.json"),
    `${JSON.stringify({
      schemaVersion: 2,
      runId: outcome.runId,
      attemptNumber: 1,
      sessionIndex: 0,
      attemptIndexInSession: 0,
      prompt: outcome.manifest.brief,
      stdout: "",
      stderr: "",
      transcript: "attempt 1",
      notices: "",
    })}\n`,
  );

  const out = runCli(["run", "reset", outcome.runId, "--output-format", "json"], { cwd: dir });
  assert.deepEqual(JSON.parse(out), { runId: outcome.runId, status: "initialized" });

  const manifest = readManifest(outcome.workspaceDir);
  assertTimestampAdvanced(beforeReset, manifest.updatedAt, "run reset json updatedAt");
  assert.equal(manifest.status, "initialized");
  assert.equal(manifest.endedAt, null);
  assert.equal(manifest.exitCode, null);
  assert.equal(manifest.totalAttemptCount, 0);
  assert.equal(manifest.maxAttemptsPerSession, 2);
  assert.equal(manifest.model, "claude-sonnet-4-6");
  assert.equal(manifest.effort, null);
  assert.equal(manifest.name, null);
  assert.equal(manifest.unrestricted, false);
  assert.equal(manifest.timeoutSec, 3600);
  assert.equal(manifest.backendSessionId, null);
  assert.ok(manifest.brief);
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.finalTasks.t1.notes, "");
  assert.equal(manifest.totalSessionCount, 0);
  assert.deepEqual(manifest.sessions, []);
  assert.deepEqual(manifest.attemptRecords, []);
  assert.equal(existsSync(join(outcome.workspaceDir, "attempts")), false);
});

test("run reset: rejects a running run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
  });

  const result = runCliExpectFail(["run", "reset", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot reset a running run/);
});

test("run delete: removes an archived run workspace and supports json output", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const textOutcome = await initRun(dir);
  const jsonOutcome = await initRun(dir);

  patchManifest(textOutcome.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.archivedAt = "2026-04-12T15:00:00.000Z";
  });
  patchManifest(jsonOutcome.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.archivedAt = "2026-04-12T15:00:00.000Z";
  });

  const textOut = runCli(["run", "delete", textOutcome.runId], { cwd: dir });
  assert.match(textOut, new RegExp(`deleted archived run ${textOutcome.runId}`));
  assert.equal(existsSync(textOutcome.workspaceDir), false);

  const jsonOut = runCli(["run", "delete", jsonOutcome.runId, "--output-format", "json"], {
    cwd: dir,
  });
  assert.deepEqual(JSON.parse(jsonOut), { runId: jsonOutcome.runId });
  assert.equal(existsSync(jsonOutcome.workspaceDir), false);
});

test("run delete: rejects non-archived runs", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "success";
    manifest.archivedAt = null;
  });

  const result = runCliExpectFail(["run", "delete", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    new RegExp(`cannot delete run ${outcome.runId} unless it is archived`),
  );
  assert.equal(existsSync(outcome.workspaceDir), true);
});

test("run delete: rejects a running run", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.archivedAt = "2026-04-12T15:00:00.000Z";
  });

  const result = runCliExpectFail(["run", "delete", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot delete a running run/);
  assert.equal(existsSync(outcome.workspaceDir), true);
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
  manifest.finalTasks.t2.status = "completed";
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  runCli(["task", "set", outcome.runId, "t1", "--notes", "Post-hoc annotation"], { cwd: dir });

  const after = readManifest(outcome.workspaceDir);
  assert.equal(after.status, "success");
  assert.equal(after.finalTasks.t1.notes, "Post-hoc annotation");
  assert.equal(after.finalTasks.t1.status, "pending");
  assert.equal(after.finalTasks.t2.status, "completed");
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
    canReset: true,
    canDelete: false,
    canReady: false,
    canResume: true,
    canAbort: false,
    abortReason: "already_terminal",
    canReconfigure: false,
    reconfigureReason: "not_initialized",
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

test("task add: remains rejected while a run is running", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
  });

  const result = runCliExpectFail(["task", "add", outcome.runId, "--title", "Follow-up"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /task add remains rejected while a run is in-flight/);
});

test("task command: missing subcommand prints usage and exits 3", async () => {
  const result = runCliExpectFail(["task"], {});
  assert.equal(result.status, 3);
  assert.match(result.stderr, /task command requires a subcommand/);
});

test("task set: status-only call can then be read back via run status --output-format json --field tasks", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });

  const out = runCli(
    ["run", "status", outcome.runId, "--output-format", "json", "--field", "tasks"],
    {
      cwd: dir,
    },
  );
  const parsed = JSON.parse(out);
  assert.equal(parsed.tasks[0].status, "completed");
  assert.equal(parsed.tasks[1].status, "pending");
});
