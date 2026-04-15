import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { createRunEventCapture } from "./helpers/run-events.mjs";
import {
  completeAllTasksFromPrompt,
  sharedRuntimeEnv,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: caller-test
backend: claude
model: claude-sonnet-4-6
---
Agent role body.
`;

const PASSIVE_AGENT = `---
schemaVersion: 1
name: caller-test-passive
backend: passive
lockedFields:
  - backend
---
Passive body.
`;

const ASSIGNMENT_WITH_CALLER = `---
schemaVersion: 1
name: caller-work
callerInstructions: |
  Hello, caller. Your run id is {{run_id}} and you're working on
  {{repo_path}}. Use {{task_runner_cmd}} status {{run_id}} to
  inspect the run, and pass --output-format json for structured
  data.
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: First
    body: First task body.
  - id: t2
    title: Second
    body: Second task body.
---
Assignment instructions body.
`;

const ASSIGNMENT_NO_CALLER = `---
schemaVersion: 1
name: plain-work
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: Only
---
Plain assignment.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-caller-"));
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
      // Complete all tasks so the run terminates success without
      // retries, keeping these tests fast.
      try {
        completeAllTasksFromPrompt(ctx.prompt);
      } catch {
        // ignore
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "sess-caller-1",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };
}

async function runFreshRun(baseDir, assignmentName, opts = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(opts.agentName ?? "caller-test", baseDir);
    const loadedAssignment = loadAssignmentConfig(assignmentName, baseDir);
    const capture = createRunEventCapture();
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      const outcome = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: opts.vars ?? { repo_path: "/tmp/caller" },
        backend: opts.backend ?? mockBackend(),
        initialize: opts.initialize ?? false,
        emitEvent: capture.emitEvent,
      });
      return {
        outcome,
        stderr: capture.stderr(),
        stdout: capture.stdout(),
      };
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

// ────────────────────────────────────────────────────────────────
// Schema + manifest freeze
// ────────────────────────────────────────────────────────────────

test("assignment schema: callerInstructions is optional and accepted as a string", async () => {
  const dir = tempDir();
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAssignmentConfig("caller-work", dir);
    assert.ok(loaded.config.callerInstructions, "callerInstructions loaded");
    assert.match(loaded.config.callerInstructions, /Hello, caller/);
    assert.match(loaded.config.callerInstructions, /{{run_id}}/);
  });
});

test("assignment schema: callerInstructions absent is legal", async () => {
  const dir = tempDir();
  writeAssignment(dir, "plain-work", ASSIGNMENT_NO_CALLER);
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAssignmentConfig("plain-work", dir);
    assert.equal(loaded.config.callerInstructions, undefined);
  });
});

test("manifest: callerInstructions frozen at first write with {{var}} interpolation", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  const { outcome } = await runFreshRun(dir, "caller-work", { initialize: true });

  const frozen = outcome.manifest.callerInstructions;
  assert.ok(frozen, "frozen into manifest");
  assert.match(frozen, new RegExp(`run id is ${outcome.runId}`));
  // {{repo_path}} gets interpolated to "/tmp/caller"; the YAML block
  // scalar wraps across a newline, so match on the token alone.
  assert.match(frozen, /\/tmp\/caller/);
  // {{var}} markers are gone — interpolated, not raw
  assert.doesNotMatch(frozen, /{{run_id}}/);
  assert.doesNotMatch(frozen, /{{repo_path}}/);
});

test("manifest: callerInstructions is null when assignment omits the field", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "plain-work", ASSIGNMENT_NO_CALLER);
  const { outcome } = await runFreshRun(dir, "plain-work", { initialize: true });
  assert.equal(outcome.manifest.callerInstructions, null);
});

test("manifest: callerInstructions is null when no assignment at all (chat mode)", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("caller-test", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    let outcome;
    try {
      outcome = await runAgent({
        loaded,
        cliVars: {},
        backend: mockBackend(),
        overrides: { message: "chat" },
      });
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(outcome.manifest.callerInstructions, null);
  });
});

// ────────────────────────────────────────────────────────────────
// Print rule: init prints; fresh run prints; resume paths skip
// ────────────────────────────────────────────────────────────────

test("init prints callerInstructions to stderr with a separator", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  const { stderr, stdout, outcome } = await runFreshRun(dir, "caller-work", {
    initialize: true,
  });

  assert.match(stderr, /── caller instructions ──/);
  assert.match(stderr, /── end caller instructions ──/);
  assert.match(stderr, new RegExp(`run id is ${outcome.runId}`));
  // stdout is reserved for the composed prompt (passive) or the
  // agent text stream (non-passive); caller instructions never go
  // there.
  assert.doesNotMatch(stdout, /caller instructions/);
});

test("fresh run prints callerInstructions to stderr", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  const { stderr } = await runFreshRun(dir, "caller-work");
  assert.match(stderr, /── caller instructions ──/);
  assert.match(stderr, /── end caller instructions ──/);
});

test("passive init prints callerInstructions alongside the passive bootstrap", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test-passive", PASSIVE_AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  const { outcome, stderr, stdout } = await runFreshRun(dir, "caller-work", {
    agentName: "caller-test-passive",
    initialize: true,
  });

  // Caller instructions on stderr
  assert.match(stderr, /── caller instructions ──/);
  assert.match(stderr, /Hello, caller/);
  // Passive bootstrap is now stored on the manifest/brief surface
  // instead of being dumped inline during init.
  assert.match(outcome.manifest.brief, /task-runner task set/);
  assert.match(outcome.manifest.brief, new RegExp(outcome.runId));
  // Stdout remains reserved for command output, not caller docs.
  assert.equal(stdout, "");
  assert.doesNotMatch(stdout, /Hello, caller/);
});

test("fresh run does NOT print callerInstructions when the assignment has none", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "plain-work", ASSIGNMENT_NO_CALLER);
  const { stderr } = await runFreshRun(dir, "plain-work");
  assert.doesNotMatch(stderr, /caller instructions/);
});

test("resume does NOT print callerInstructions (caller already saw it on fresh run)", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);

  // Fresh run — completes
  const first = await runFreshRun(dir, "caller-work");
  assert.match(first.stderr, /── caller instructions ──/);

  await withSharedRuntimeEnv(dir, async () => {
    // Resume — must NOT reprint
    const target = resolveResumeTarget(first.outcome.runId, dir);
    const loaded = loadAgentConfig("caller-test", dir);
    const capture = createRunEventCapture();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await runAgent({
        loaded,
        cliVars: {},
        backend: mockBackend(),
        overrides: { message: "continue" },
        resume: target,
        emitEvent: capture.emitEvent,
      });
    } finally {
      process.chdir(originalCwd);
    }
    const stderr = capture.stderr();
    assert.doesNotMatch(stderr, /── caller instructions ──/);
  });
});

test("execute-after-init does NOT print callerInstructions (init already did)", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);

  // Init — prints
  const init = await runFreshRun(dir, "caller-work", { initialize: true });
  assert.match(init.stderr, /── caller instructions ──/);

  await withSharedRuntimeEnv(dir, async () => {
    // Execute-after-init — must NOT reprint
    const target = resolveResumeTarget(init.outcome.runId, dir);
    const loaded = loadAgentConfig("caller-test", dir);
    const capture = createRunEventCapture();
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await runAgent({
        loaded,
        cliVars: {},
        backend: mockBackend(),
        resume: target,
        emitEvent: capture.emitEvent,
      });
    } finally {
      process.chdir(originalCwd);
    }
    const stderr = capture.stderr();
    assert.doesNotMatch(stderr, /── caller instructions ──/);
  });
});

// ────────────────────────────────────────────────────────────────
// Ad-hoc agent composition
// ────────────────────────────────────────────────────────────────

test("ad-hoc agent + assignment with callerInstructions still prints them", async () => {
  const dir = tempDir();
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  // No agent file — use ad-hoc synthesis via CLI.
  const { spawnSync } = await import("node:child_process");
  const spawn = spawnSync(
    "node",
    [
      CLI_PATH,
      "init",
      "--backend",
      "passive",
      "--assignment",
      "caller-work",
      "--var",
      "repo_path=.",
    ],
    {
      cwd: dir,
      env: {
        ...process.env,
        ...sharedRuntimeEnv(dir),
      },
      encoding: "utf8",
    },
  );
  assert.equal(spawn.status, 0);
  assert.match(spawn.stderr, /── caller instructions ──/);
  assert.match(spawn.stderr, /Hello, caller/);
  assert.doesNotMatch(spawn.stdout, /Hello, caller/);

  const [runId] = readdirSync(join(dir, "runs", "unknown"));
  const brief = runCli(["brief", runId], { cwd: dir });
  assert.match(brief, /task-runner task set/);
  assert.doesNotMatch(brief, /Hello, caller/);
});

// ────────────────────────────────────────────────────────────────
// Status output integration
// ────────────────────────────────────────────────────────────────

test("status --output-format json includes callerInstructions", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  const { outcome } = await runFreshRun(dir, "caller-work", { initialize: true });
  const out = runCli(
    ["status", outcome.runId, "--output-format", "json", "--field", "callerInstructions"],
    { cwd: dir },
  );
  const parsed = JSON.parse(out);
  assert.ok(parsed.callerInstructions);
  assert.match(parsed.callerInstructions, /Hello, caller/);
  assert.match(parsed.callerInstructions, new RegExp(outcome.runId));
  assert.match(parsed.callerInstructions, /task-runner status/);
});

test("status text output does NOT reprint callerInstructions", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(dir, "caller-work", ASSIGNMENT_WITH_CALLER);
  const { outcome } = await runFreshRun(dir, "caller-work", { initialize: true });

  const text = runCli(["status", outcome.runId], { cwd: dir });
  // status text output is a read-only inspector and should stay
  // terse — the caller read the instructions on the first write
  // and can re-fetch via --output-format json if needed.
  assert.doesNotMatch(text, /── caller instructions ──/);
  assert.doesNotMatch(text, /Hello, caller/);
});

// ────────────────────────────────────────────────────────────────
// Edge cases
// ────────────────────────────────────────────────────────────────

test("empty callerInstructions field is treated as absent", async () => {
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(
    dir,
    "empty-caller",
    `---
schemaVersion: 1
name: empty-caller
callerInstructions: ""
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: Only
---
Body.
`,
  );
  const { stderr, outcome } = await runFreshRun(dir, "empty-caller", { initialize: true });
  assert.equal(outcome.manifest.callerInstructions, null);
  assert.doesNotMatch(stderr, /── caller instructions ──/);
});

test("whitespace-only callerInstructions is treated as absent (no empty banner)", async () => {
  // Regression guard for the LOW review finding: a whitespace-only
  // value used to freeze into the manifest and later render an empty
  // banner block at print time. Normalized with .trim() before the
  // length check now.
  const dir = tempDir();
  writeAgent(dir, "caller-test", AGENT);
  writeAssignment(
    dir,
    "whitespace-caller",
    `---
schemaVersion: 1
name: whitespace-caller
callerInstructions: "   \\n\\t  "
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: Only
---
Body.
`,
  );
  const { stderr, outcome } = await runFreshRun(dir, "whitespace-caller", { initialize: true });
  assert.equal(
    outcome.manifest.callerInstructions,
    null,
    "whitespace-only callerInstructions normalizes to null",
  );
  assert.doesNotMatch(stderr, /── caller instructions ──/, "no empty banner printed");
});
