import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { ResumeError, resolveResumeTarget } from "../dist/runner/manifest.js";
import { runAgent } from "../dist/runner/run-loop.js";

const CLI_PATH = resolvePath(new URL("../dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: override-test
backend: claude
model: claude-sonnet-4-6
---
Agent body.
`;

const AGENT_LOCKED_SESSION = `---
schemaVersion: 1
name: override-test-locked
backend: claude
model: claude-sonnet-4-6
lockedFields:
  - sessionName
---
Agent body.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: override-work
sessionName: locked name
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: First
---
Work on {{repo_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-overrides-"));
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

function mockBackend() {
  return {
    id: "mock",
    async invoke(ctx) {
      // For tests that need the task to complete, simulate the agent
      // marking t1 completed so the run terminates success.
      try {
        const match = ctx.prompt.match(/\/\.task-runner\/\S+?\/assignment\.md/);
        if (match) {
          const plan = readFileSync(`.${match[0]}`, "utf8");
          const updated = plan.replace(
            /(<!-- task-id: t1 -->[\s\S]*?\*\*Status:\*\*) \S+/,
            "$1 completed",
          );
          writeFileSync(`.${match[0]}`, updated);
        }
      } catch {
        // ignore
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "sess-override-1",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };
}

async function runFresh(baseDir, opts = {}) {
  const loaded = loadAgentConfig(opts.agentName ?? "override-test", baseDir);
  const loadedAssignment = loadAssignmentConfig(opts.assignmentName ?? "override-work", baseDir);
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars: { repo_path: "/tmp/override" },
      backend: mockBackend(),
      initialize: opts.initialize ?? false,
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
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

// ───────────────────────────────────────────────────────────────
// Resume override rejections (regular resume, prior terminal state)
// ───────────────────────────────────────────────────────────────

test("resume rejects --cwd (session is cwd-bound)", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir);

  const result = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--cwd", "/tmp/other", "continue"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--cwd cannot be combined with --resume-run/);
  assert.match(result.stderr, /bound to the cwd/);
});

test("resume rejects --var (silently no-op today; reject loudly)", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir);

  const result = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--var", "repo_path=/tmp/other", "continue"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--var cannot be combined with --resume-run/);
});

test("resume rejects --agent (silently ignored today; reject loudly)", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir);

  const result = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--agent", "override-test", "continue"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--agent cannot be combined with --resume-run/);
  assert.match(result.stderr, /manifest-canonical/);
});

test("resume rejects --assignment (unchanged behavior, via central validator)", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir);

  const result = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--assignment", "override-work", "continue"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--assignment cannot be combined with --resume-run/);
});

test("resume rejects --backend (unchanged behavior, via central validator)", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir);

  const result = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--backend", "codex", "continue"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--backend cannot be combined with --resume-run/);
});

test("resume rejects --backend-session-id", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir);

  const result = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--backend-session-id", "some-imported-id", "continue"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--backend-session-id cannot be combined with --resume-run/);
});

test("resume requires message or --add-task on a terminal run", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir);

  const result = runCliExpectFail(["run", "--resume-run", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    /--resume-run requires a follow-up message or at least one --add-task/,
  );
});

// ───────────────────────────────────────────────────────────────
// Execute-after-init: no overrides at all
// ───────────────────────────────────────────────────────────────

test("execute-after-init rejects --session-name (fixes the priorInitialized lock bypass)", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test-locked", AGENT_LOCKED_SESSION);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir, {
    agentName: "override-test-locked",
    initialize: true,
  });

  const result = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--session-name", "attempt-to-override"],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /resuming an initialized run does not accept/);
  assert.match(result.stderr, /--session-name/);
});

test("execute-after-init rejects model/effort/timeout/max-retries/unrestricted in one combined error", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir, { initialize: true });

  // Test each in isolation to confirm they all make it into the
  // forbidden list.
  const tryOne = (flag, value) =>
    runCliExpectFail(["run", "--resume-run", outcome.runId, flag, value], { cwd: dir });

  for (const [flag, value] of [
    ["--model", "claude-opus-4-6"],
    ["--effort", "high"],
    ["--timeout-sec", "120"],
    ["--max-retries", "1"],
  ]) {
    const result = tryOne(flag, value);
    assert.equal(result.status, 3);
    assert.match(result.stderr, /resuming an initialized run does not accept/);
  }

  const unrestrictedResult = runCliExpectFail(
    ["run", "--resume-run", outcome.runId, "--unrestricted"],
    { cwd: dir },
  );
  assert.equal(unrestrictedResult.status, 3);
  assert.match(unrestrictedResult.stderr, /resuming an initialized run does not accept/);
});

test("execute-after-init rejects the positional message", async () => {
  const dir = tempDir();
  writeAgent(dir, "override-test", AGENT);
  writeAssignment(dir, "override-work", ASSIGNMENT);
  const outcome = await runFresh(dir, { initialize: true });

  const result = runCliExpectFail(["run", "--resume-run", outcome.runId, "a follow-up"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /resuming an initialized run does not accept/);
  assert.match(result.stderr, /message/);
});

// ───────────────────────────────────────────────────────────────
// Manifest corruption detection (finding #3)
// ───────────────────────────────────────────────────────────────

test("resolveResumeTarget rejects a manifest with finalTasks: null", () => {
  const dir = tempDir();
  const workspaceDir = join(dir, ".task-runner", "corrupt1");
  mkdirSync(workspaceDir, { recursive: true });
  const m = baseManifest("corrupt1", workspaceDir);
  m.finalTasks = null;
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(m, null, 2)}\n`);

  assert.throws(
    () => resolveResumeTarget("corrupt1", dir),
    (err) => {
      assert.ok(err instanceof ResumeError);
      assert.match(err.message, /does not look like a task-runner run\.json/);
      return true;
    },
  );
});

test("resolveResumeTarget rejects a manifest missing assignmentPath", () => {
  const dir = tempDir();
  const workspaceDir = join(dir, ".task-runner", "corrupt2");
  mkdirSync(workspaceDir, { recursive: true });
  const m = baseManifest("corrupt2", workspaceDir);
  // Setting to undefined drops the field from JSON.stringify output,
  // which is what we're simulating: a truncated or partially-written
  // manifest that's missing a required top-level field.
  m.assignmentPath = undefined;
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(m, null, 2)}\n`);

  assert.throws(
    () => resolveResumeTarget("corrupt2", dir),
    (err) => {
      assert.ok(err instanceof ResumeError);
      assert.match(err.message, /does not look like a task-runner run\.json/);
      return true;
    },
  );
});

test("resolveResumeTarget rejects a manifest with runtimeVars: null", () => {
  const dir = tempDir();
  const workspaceDir = join(dir, ".task-runner", "corrupt3");
  mkdirSync(workspaceDir, { recursive: true });
  const m = baseManifest("corrupt3", workspaceDir);
  m.runtimeVars = null;
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(m, null, 2)}\n`);

  assert.throws(
    () => resolveResumeTarget("corrupt3", dir),
    (err) => {
      assert.ok(err instanceof ResumeError);
      assert.match(err.message, /does not look like a task-runner run\.json/);
      return true;
    },
  );
});

test("resolveResumeTarget accepts a well-formed v2 manifest", () => {
  const dir = tempDir();
  const workspaceDir = join(dir, ".task-runner", "wellformed");
  mkdirSync(workspaceDir, { recursive: true });
  const m = baseManifest("wellformed", workspaceDir);
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(m, null, 2)}\n`);

  const resolved = resolveResumeTarget("wellformed", dir);
  assert.equal(resolved.manifest.runId, "wellformed");
  assert.equal(resolved.manifest.schemaVersion, 2);
});

// Build a minimal schemaVersion-2 manifest with every required field.
// Used by the corruption tests so each test can tweak one field at a
// time to exercise isRunManifest's checks.
function baseManifest(runId, workspaceDir) {
  return {
    schemaVersion: 2,
    runId,
    agent: {
      name: "override-test",
      sourcePath: null,
      instructions: "",
    },
    assignment: null,
    backend: "claude",
    model: "claude-sonnet-4-6",
    effort: null,
    message: null,
    sessionName: null,
    unrestricted: false,
    cwd: "/tmp",
    lockedFields: [],
    timeoutSec: 3600,
    assignmentPath: join(workspaceDir, "assignment.md"),
    workspaceDir,
    startedAt: "2026-04-11T16:00:00Z",
    endedAt: "2026-04-11T16:05:00Z",
    status: "success",
    exitCode: 0,
    attempts: 1,
    maxAttempts: 4,
    tasksCompleted: 1,
    tasksTotal: 1,
    backendSessionId: "sess-base",
    runtimeVars: {},
    pendingPrompt: null,
    callerInstructions: null,
    finalTasks: {
      t1: {
        id: "t1",
        title: "First",
        body: "",
        status: "completed",
        notes: "",
      },
    },
    sessionCount: 1,
    sessions: [],
    attemptRecords: [],
  };
}
