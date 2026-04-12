import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { passiveBackend } from "../dist/backends/passive.js";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/runner/run-loop.js";
import { sharedRuntimeEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../dist/cli.js", import.meta.url).pathname);

const PASSIVE_AGENT = `---
schemaVersion: 1
name: passive-agent
backend: passive
lockedFields:
  - backend
---
You drive this run from outside task-runner.
Work each task via \`task-runner task set\`.
`;

const PASSIVE_AGENT_NO_LOCK = `---
schemaVersion: 1
name: passive-loose
backend: passive
---
Body.
`;

const CLAUDE_AGENT = `---
schemaVersion: 1
name: claude-agent
backend: claude
model: claude-sonnet-4-6
---
Body.
`;

const TWO_TASK_ASSIGNMENT = `---
schemaVersion: 1
name: two-task
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
---
Work.
`;

const ONE_TASK_ASSIGNMENT = `---
schemaVersion: 1
name: one-task
tasks:
  - id: only
    title: Only task
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-passive-"));
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

async function initPassive(baseDir, agentName = "passive-agent", assignmentName = "two-task") {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    const loadedAssignment = loadAssignmentConfig(assignmentName, baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: passiveBackend,
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
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: {
      ...process.env,
      ...sharedRuntimeEnv(opts.cwd ?? process.cwd()),
    },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliSpawnExpectFail(args, opts = {}) {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: {
        ...process.env,
        ...sharedRuntimeEnv(opts.cwd ?? process.cwd()),
      },
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

test("passive agent: init creates manifest with backend=passive, status=initialized", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);

  const outcome = await initPassive(dir);
  assert.equal(outcome.manifest.backend, "passive");
  assert.equal(outcome.manifest.status, "initialized");
  assert.equal(outcome.manifest.tasksTotal, 2);
  assert.equal(outcome.manifest.tasksCompleted, 0);
  assert.equal(outcome.exitCode, 0);

  // pendingPrompt should contain the PASSIVE workflow template
  const prompt = outcome.manifest.pendingPrompt ?? "";
  assert.ok(prompt.length > 0, "pendingPrompt populated");
  assert.match(prompt, /task-runner task set/, "prompt uses CLI workflow template");
  assert.match(prompt, new RegExp(outcome.runId), "prompt interpolates run id");
});

test("passive agent: init output — bootstrap on stdout, progress on stderr", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);

  const { spawnSync } = await import("node:child_process");
  const res = spawnSync(
    "node",
    [CLI_PATH, "init", "--agent", "passive-agent", "--assignment", "two-task"],
    {
      cwd: dir,
      env: {
        ...process.env,
        ...sharedRuntimeEnv(dir),
      },
      encoding: "utf8",
    },
  );
  assert.equal(res.status, 0);
  // Progress lines on stderr
  assert.match(res.stderr, /initialized passive agent=passive-agent/);
  assert.match(res.stderr, /drive with: task-runner task set/);
  // Bootstrap on stdout — contains the CLI workflow instructions
  assert.match(res.stdout, /task-runner task set/);
  assert.match(res.stdout, /claim it/i);
});

test("passive agent: `run` is rejected with a clear error", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);

  const result = runCliSpawnExpectFail(
    ["run", "--agent", "passive-agent", "--assignment", "two-task"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot run passive agent/);
  assert.match(result.stderr, /task-runner init --agent/);
});

test("passive agent: `run --resume-run` is rejected", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  // No message / no --add-task — the forbidden-args check on an
  // initialized run would otherwise fire before the passive check.
  const result = runCliSpawnExpectFail(["run", "--resume-run", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot run passive agent/);
});

test("passive auto-finalize: status flips to success when every task is completed", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  // Still work to do — status should remain initialized
  let m = readManifest(outcome.workspaceDir);
  assert.equal(m.status, "initialized");
  assert.equal(m.exitCode, null);
  assert.equal(m.endedAt, null);

  runCli(["task", "set", outcome.runId, "t2", "--status", "completed"], { cwd: dir });
  m = readManifest(outcome.workspaceDir);
  assert.equal(m.status, "success");
  assert.equal(m.exitCode, 0);
  assert.ok(m.endedAt, "endedAt set when finalizing");
  assert.equal(m.tasksCompleted, 2);
});

test("passive auto-finalize: status flips to blocked when any task is blocked (rest terminal)", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", outcome.runId, "t2", "--status", "blocked", "--notes", "needs decision"], {
    cwd: dir,
  });

  const m = readManifest(outcome.workspaceDir);
  assert.equal(m.status, "blocked");
  assert.equal(m.exitCode, 2);
  assert.ok(m.endedAt);
});

test("passive reset: success run returns to initialized with original tasks", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", outcome.runId, "t2", "--status", "completed"], { cwd: dir });
  assert.equal(readManifest(outcome.workspaceDir).status, "success");

  runCli(["run", "reset", outcome.runId], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "initialized");
  assert.equal(manifest.exitCode, null);
  assert.equal(manifest.endedAt, null);
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.finalTasks.t2.status, "pending");
  assert.equal(manifest.pendingPrompt, manifest.resetSeed.pendingPrompt);
});

test("passive reset: blocked run returns to initialized with notes cleared", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", outcome.runId, "t2", "--status", "blocked", "--notes", "needs decision"], {
    cwd: dir,
  });
  assert.equal(readManifest(outcome.workspaceDir).status, "blocked");

  runCli(["run", "reset", outcome.runId], { cwd: dir });

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "initialized");
  assert.equal(manifest.finalTasks.t1.status, "pending");
  assert.equal(manifest.finalTasks.t2.status, "pending");
  assert.equal(manifest.finalTasks.t2.notes, "");
});

test("passive auto-finalize: in_progress blocks finalization", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", outcome.runId, "t2", "--status", "in_progress"], { cwd: dir });

  const m = readManifest(outcome.workspaceDir);
  assert.equal(m.status, "initialized");
  assert.equal(m.exitCode, null);
});

test("passive self-healing: reopening a completed task on a success run flips back to initialized", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", outcome.runId, "t2", "--status", "completed"], { cwd: dir });
  assert.equal(readManifest(outcome.workspaceDir).status, "success");

  runCli(["task", "set", outcome.runId, "t1", "--status", "in_progress"], { cwd: dir });
  const m = readManifest(outcome.workspaceDir);
  assert.equal(m.status, "initialized");
  assert.equal(m.exitCode, null);
  assert.equal(m.endedAt, null);
});

test("passive self-healing: task add on a success run flips back to initialized", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-loose", PASSIVE_AGENT_NO_LOCK);
  writeAssignment(dir, "one-task", ONE_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir, "passive-loose", "one-task");

  runCli(["task", "set", outcome.runId, "only", "--status", "completed"], { cwd: dir });
  assert.equal(readManifest(outcome.workspaceDir).status, "success");

  runCli(["task", "add", outcome.runId, "--title", "follow-up"], { cwd: dir });
  const m = readManifest(outcome.workspaceDir);
  assert.equal(m.status, "initialized");
  assert.equal(m.exitCode, null);
  assert.equal(m.tasksTotal, 2);
});

test("non-passive run: task set completing all tasks does NOT auto-finalize", async () => {
  const dir = tempDir();
  writeAgent(dir, "claude-agent", CLAUDE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);

  // Init a non-passive run directly with runAgent (no backend
  // invocation happens because initialize=true).
  let outcome;
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("claude-agent", dir);
    const loadedAssignment = loadAssignmentConfig("two-task", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      outcome = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: { id: "claude", invoke: async () => ({}) },
        initialize: true,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", outcome.runId, "t2", "--status", "completed"], { cwd: dir });

  const m = readManifest(outcome.workspaceDir);
  assert.equal(m.status, "initialized", "non-passive stays initialized");
  assert.equal(m.tasksCompleted, 2);
});

test("passive agent: --backend claude override is rejected by lockedFields", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);

  const result = runCliSpawnExpectFail(
    ["init", "--agent", "passive-agent", "--assignment", "two-task", "--backend", "claude"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot override locked field: backend/);
});

test("passive status: Attempts and Sessions lines are hidden", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  const text = runCli(["status", outcome.runId], { cwd: dir });
  assert.doesNotMatch(text, /Attempts:/);
  assert.doesNotMatch(text, /Sessions:/);
  assert.match(text, /Status: initialized/);
});

test("passive status: initialized footer points at task set, not run", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  const text = runCli(["status", outcome.runId], { cwd: dir });
  assert.match(text, /Drive this run externally:/);
  assert.match(
    text,
    new RegExp(`task-runner task set ${outcome.runId} <task-id> --status in_progress`),
  );
  assert.doesNotMatch(text, /task-runner run --resume-run/);
});

test("passive status json exposes passive task-mutation capabilities and no resume", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  const projected = JSON.parse(
    runCli(["status", outcome.runId, "--output-format", "json", "--field", "capabilities"], {
      cwd: dir,
    }),
  );

  assert.deepEqual(projected.capabilities, {
    canArchive: true,
    canUnarchive: false,
    canResume: false,
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
    },
  });
});

test("passive backend: invoke() throws PassiveBackendNotInvokableError", async () => {
  await assert.rejects(async () => {
    await passiveBackend.invoke({
      prompt: "anything",
      cwd: "/tmp",
      env: {},
      timeoutSec: 10,
    });
  }, /passive backend cannot be invoked/i);
});

test("passive finalized run: notes-only task set preserves endedAt and exitCode", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  // Finalize the run to success.
  runCli(["task", "set", outcome.runId, "t1", "--status", "completed"], { cwd: dir });
  runCli(["task", "set", outcome.runId, "t2", "--status", "completed"], { cwd: dir });
  const finalized = readManifest(outcome.workspaceDir);
  assert.equal(finalized.status, "success");
  assert.equal(finalized.exitCode, 0);
  const originalEndedAt = finalized.endedAt;
  assert.ok(originalEndedAt, "endedAt stamped on finalization");

  // Brief pause so a Date.now() rewrite would produce a different
  // timestamp and the equality assertion would catch the regression.
  await new Promise((r) => setTimeout(r, 20));

  // Notes-only edit on an already-completed task. Status stays
  // "completed", terminal state stays "success", endedAt should be
  // frozen.
  runCli(
    [
      "task",
      "set",
      outcome.runId,
      "t1",
      "--notes",
      "Post-hoc annotation added after finalization.",
    ],
    { cwd: dir },
  );

  const afterNote = readManifest(outcome.workspaceDir);
  assert.equal(afterNote.status, "success", "status still success");
  assert.equal(afterNote.exitCode, 0, "exitCode preserved");
  assert.equal(
    afterNote.endedAt,
    originalEndedAt,
    "endedAt preserved across notes-only edit on terminal run",
  );
  assert.equal(
    afterNote.finalTasks.t1.notes,
    "Post-hoc annotation added after finalization.",
    "notes mutation still applied",
  );
});

test("passive re-orient: status --field pendingPrompt returns the bootstrap text", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "two-task", TWO_TASK_ASSIGNMENT);
  const outcome = await initPassive(dir);

  const out = runCli(
    ["status", outcome.runId, "--output-format", "json", "--field", "pendingPrompt"],
    { cwd: dir },
  );
  const parsed = JSON.parse(out);
  assert.ok(parsed.pendingPrompt);
  assert.match(parsed.pendingPrompt, /task-runner task set/);
});

test("bundled passive-example agent is loadable and passes schema", async () => {
  await withSharedRuntimeEnv(process.cwd(), async () => {
    const loaded = loadAgentConfig(
      "/home/kevin/worktrees/task-runner/agents/passive-example/agent.md",
    );
    assert.equal(loaded.config.backend, "passive");
    assert.equal(loaded.config.name, "passive-example");
    assert.ok(
      loaded.config.lockedFields.includes("backend"),
      "bundled passive-example locks backend",
    );
  });
});
