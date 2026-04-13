import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import {
  DEFAULT_MAX_CALL_DEPTH,
  RecursionDepthError,
  TASK_RUNNER_CALL_DEPTH_ENV,
  TASK_RUNNER_MAX_CALL_DEPTH_ENV,
  buildChildRecursionEnv,
  checkRecursionDepth,
  readRecursionState,
} from "../packages/core/dist/core/run/recursion-guard.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import {
  assignmentPathFromPrompt,
  withEnv,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

// ─── Pure helper tests ──────────────────────────────────────────────────────

test("readRecursionState: defaults when env is empty", () => {
  const state = readRecursionState({});
  assert.equal(state.currentDepth, 0);
  assert.equal(state.maxDepth, DEFAULT_MAX_CALL_DEPTH);
});

test("readRecursionState: parses numeric env values", () => {
  const state = readRecursionState({
    [TASK_RUNNER_CALL_DEPTH_ENV]: "2",
    [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: "10",
  });
  assert.equal(state.currentDepth, 2);
  assert.equal(state.maxDepth, 10);
});

test("readRecursionState: invalid values fall back to defaults", () => {
  const state = readRecursionState({
    [TASK_RUNNER_CALL_DEPTH_ENV]: "not-a-number",
    [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: "-5",
  });
  assert.equal(state.currentDepth, 0);
  assert.equal(state.maxDepth, DEFAULT_MAX_CALL_DEPTH);
});

test("readRecursionState: negative depth treated as 0", () => {
  const state = readRecursionState({
    [TASK_RUNNER_CALL_DEPTH_ENV]: "-1",
  });
  assert.equal(state.currentDepth, 0);
});

test("checkRecursionDepth: under cap is allowed", () => {
  assert.doesNotThrow(() => checkRecursionDepth({ currentDepth: 3, maxDepth: 4 }));
  assert.doesNotThrow(() => checkRecursionDepth({ currentDepth: 0, maxDepth: 1 }));
});

test("checkRecursionDepth: at cap throws RecursionDepthError", () => {
  assert.throws(
    () => checkRecursionDepth({ currentDepth: 4, maxDepth: 4 }),
    (err) => {
      assert.ok(err instanceof RecursionDepthError);
      assert.equal(err.currentDepth, 4);
      assert.equal(err.maxDepth, 4);
      return true;
    },
  );
});

test("checkRecursionDepth: above cap throws too", () => {
  assert.throws(() => checkRecursionDepth({ currentDepth: 7, maxDepth: 4 }), RecursionDepthError);
});

test("buildChildRecursionEnv: increments depth, propagates max", () => {
  const env = buildChildRecursionEnv({ currentDepth: 1, maxDepth: 4 });
  assert.equal(env[TASK_RUNNER_CALL_DEPTH_ENV], "2");
  assert.equal(env[TASK_RUNNER_MAX_CALL_DEPTH_ENV], "4");
});

test("buildChildRecursionEnv: starts a fresh chain at depth 1", () => {
  const env = buildChildRecursionEnv({ currentDepth: 0, maxDepth: 4 });
  assert.equal(env[TASK_RUNNER_CALL_DEPTH_ENV], "1");
});

// ─── runAgent integration tests ─────────────────────────────────────────────

const DEPTH_AGENT = `---
schemaVersion: 1
name: depth-agent
backend: claude
---
Agent.
`;

const DEPTH_ASSIGNMENT = `---
schemaVersion: 1
name: depth-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-depth-"));
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

function editStatus(content, taskId, newStatus) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${newStatus}`);
  return content.slice(0, start) + updated + content.slice(end);
}

function captureBackend(captured) {
  return {
    id: "mock",
    async invoke(ctx) {
      captured.env = ctx.env;
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
      if (absPlan) {
        const plan = readFileSync(absPlan, "utf8");
        writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "sess-depth-1",
        transcript: "ok",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };
}

async function runIn(baseDir, opts) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("depth-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("depth-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: opts.backend,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("runAgent: default cap is 1 — top-level allowed, nested refused", async () => {
  const dir = tempDir();
  writeAgent(dir, "depth-agent", DEPTH_AGENT);
  writeAssignment(dir, "depth-work", DEPTH_ASSIGNMENT);

  // Top-level (depth=0) with default cap (1) is allowed.
  const captured = {};
  await withEnv(
    {
      [TASK_RUNNER_CALL_DEPTH_ENV]: undefined,
      [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: undefined,
    },
    async () => {
      await runIn(dir, { backend: captureBackend(captured) });
    },
  );
  assert.equal(captured.env[TASK_RUNNER_CALL_DEPTH_ENV], "1");
  assert.equal(captured.env[TASK_RUNNER_MAX_CALL_DEPTH_ENV], "1");

  // The would-be grandchild (depth=1, default cap 1) is refused.
  await withEnv(
    {
      [TASK_RUNNER_CALL_DEPTH_ENV]: "1",
      [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: undefined,
    },
    async () => {
      await assert.rejects(
        () => runIn(dir, { backend: captureBackend({}) }),
        (err) => {
          assert.ok(err instanceof RecursionDepthError);
          assert.equal(err.currentDepth, 1);
          assert.equal(err.maxDepth, 1);
          return true;
        },
      );
    },
  );
});

test("runAgent: clean env → child env has depth=1", async () => {
  const dir = tempDir();
  writeAgent(dir, "depth-agent", DEPTH_AGENT);
  writeAssignment(dir, "depth-work", DEPTH_ASSIGNMENT);

  const captured = {};
  await withEnv(
    {
      [TASK_RUNNER_CALL_DEPTH_ENV]: undefined,
      [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: undefined,
    },
    async () => {
      await runIn(dir, { backend: captureBackend(captured) });
    },
  );
  assert.equal(captured.env[TASK_RUNNER_CALL_DEPTH_ENV], "1");
  assert.equal(captured.env[TASK_RUNNER_MAX_CALL_DEPTH_ENV], String(DEFAULT_MAX_CALL_DEPTH));
});

test("runAgent: depth=2 in env → child env has depth=3", async () => {
  const dir = tempDir();
  writeAgent(dir, "depth-agent", DEPTH_AGENT);
  writeAssignment(dir, "depth-work", DEPTH_ASSIGNMENT);

  const captured = {};
  await withEnv(
    {
      [TASK_RUNNER_CALL_DEPTH_ENV]: "2",
      [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: "5",
    },
    async () => {
      await runIn(dir, { backend: captureBackend(captured) });
    },
  );
  assert.equal(captured.env[TASK_RUNNER_CALL_DEPTH_ENV], "3");
  assert.equal(captured.env[TASK_RUNNER_MAX_CALL_DEPTH_ENV], "5");
});

test("runAgent: at the cap throws RecursionDepthError before any work", async () => {
  const dir = tempDir();
  writeAgent(dir, "depth-agent", DEPTH_AGENT);
  writeAssignment(dir, "depth-work", DEPTH_ASSIGNMENT);

  const captured = {};
  await withEnv(
    {
      [TASK_RUNNER_CALL_DEPTH_ENV]: "4",
      [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: "4",
    },
    async () => {
      await assert.rejects(
        () => runIn(dir, { backend: captureBackend(captured) }),
        (err) => {
          assert.ok(err instanceof RecursionDepthError);
          assert.equal(err.currentDepth, 4);
          assert.equal(err.maxDepth, 4);
          return true;
        },
      );
    },
  );
  assert.equal(captured.env, undefined, "backend was never invoked");
});

test("runAgent: above the cap also throws", async () => {
  const dir = tempDir();
  writeAgent(dir, "depth-agent", DEPTH_AGENT);
  writeAssignment(dir, "depth-work", DEPTH_ASSIGNMENT);

  await withEnv(
    {
      [TASK_RUNNER_CALL_DEPTH_ENV]: "10",
      [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: "4",
    },
    async () => {
      await assert.rejects(() => runIn(dir, { backend: captureBackend({}) }), RecursionDepthError);
    },
  );
});

test("runAgent: raised cap allows deeper invocation", async () => {
  const dir = tempDir();
  writeAgent(dir, "depth-agent", DEPTH_AGENT);
  writeAssignment(dir, "depth-work", DEPTH_ASSIGNMENT);

  const captured = {};
  await withEnv(
    {
      [TASK_RUNNER_CALL_DEPTH_ENV]: "9",
      [TASK_RUNNER_MAX_CALL_DEPTH_ENV]: "10",
    },
    async () => {
      await runIn(dir, { backend: captureBackend(captured) });
    },
  );
  assert.equal(captured.env[TASK_RUNNER_CALL_DEPTH_ENV], "10");
});
