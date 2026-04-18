import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../apps/cli/dist/cli/parse-args.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { LockedFieldError, runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { setTaskStatusesForPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLAUDE_AGENT = `---
schemaVersion: 1
name: claude-agent
backend: claude
model: claude-sonnet-4-6
effort: medium
---
Agent role.
`;

const CURSOR_AGENT = `---
schemaVersion: 1
name: cursor-agent
backend: cursor
model: provider/gpt-5.4
---
Agent role.
`;

const LOCKED_BACKEND_AGENT = `---
schemaVersion: 1
name: locked-backend
backend: claude
model: claude-sonnet-4-6
lockedFields: [backend]
---
Agent role.
`;

const ONE_TASK_ASSIGNMENT = `---
schemaVersion: 1
name: one-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-backend-"));
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent.md");
  writeFileSync(path, body);
  return path;
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "assignment.md");
  writeFileSync(path, body);
  return path;
}

const okBackend = (id) => ({
  id,
  async invoke(ctx) {
    try {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
    } catch {
      // Chat-mode prompts do not expose task state.
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      sessionId: null,
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    };
  },
});

async function runIn(baseDir, agentName, overrides) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    const loadedAssignment = loadAssignmentConfig("one-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: okBackend("mock-codex"),
        overrides,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("parseArgs: --backend accepts claude, codex, cursor, and pi", () => {
  const a = parseArgs(["node", "task-runner", "run", "--agent", "x", "--backend", "claude"]);
  assert.equal(a.backend, "claude");
  const b = parseArgs(["node", "task-runner", "run", "--agent", "x", "--backend", "codex"]);
  assert.equal(b.backend, "codex");
  const c = parseArgs(["node", "task-runner", "run", "--agent", "x", "--backend", "cursor"]);
  assert.equal(c.backend, "cursor");
  const d = parseArgs(["node", "task-runner", "run", "--agent", "x", "--backend", "pi"]);
  assert.equal(d.backend, "pi");
});

test("parseArgs: --backend rejects unknown values", () => {
  assert.throws(
    () => parseArgs(["node", "task-runner", "run", "--agent", "x", "--backend", "gpt-4"]),
    /--backend must be one of/,
  );
});

test("override: --backend on a claude agent persists in manifest as the override value", async () => {
  const dir = tempDir();
  writeAgent(dir, "claude-agent", CLAUDE_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  const outcome = await runIn(dir, "claude-agent", { backend: "codex" });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.backend, "codex");
});

test("override: --backend without --model drops the agent's backend-specific model", async () => {
  const dir = tempDir();
  writeAgent(dir, "claude-agent", CLAUDE_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  const outcome = await runIn(dir, "claude-agent", { backend: "codex" });
  assert.equal(outcome.manifest.model, null, "agent's claude model is dropped");
});

test("override: --backend with --model uses the new model", async () => {
  const dir = tempDir();
  writeAgent(dir, "claude-agent", CLAUDE_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  const outcome = await runIn(dir, "claude-agent", {
    backend: "codex",
    model: "gpt-5.4",
  });
  assert.equal(outcome.manifest.backend, "codex");
  assert.equal(outcome.manifest.model, "gpt-5.4");
});

test("override: no --backend keeps the agent's declared backend in the manifest", async () => {
  const dir = tempDir();
  writeAgent(dir, "claude-agent", CLAUDE_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  const outcome = await runIn(dir, "claude-agent", undefined);
  assert.equal(outcome.manifest.backend, "claude");
  assert.equal(outcome.manifest.model, "claude-sonnet-4-6");
});

test("locked: lockedFields: [backend] rejects --backend override", async () => {
  const dir = tempDir();
  writeAgent(dir, "locked-backend", LOCKED_BACKEND_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  await assert.rejects(
    () => runIn(dir, "locked-backend", { backend: "codex" }),
    (err) => {
      assert.ok(err instanceof LockedFieldError);
      assert.equal(err.field, "backend");
      assert.ok(err.message.includes("backend"));
      return true;
    },
  );
});

test("locked: locked backend still allows other unrelated overrides", async () => {
  const dir = tempDir();
  writeAgent(dir, "locked-backend", LOCKED_BACKEND_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  const outcome = await runIn(dir, "locked-backend", { maxRetries: 5 });
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.manifest.backend, "claude");
});

test("override: switching from claude to cursor drops the claude model", async () => {
  const dir = tempDir();
  writeAgent(dir, "claude-agent", CLAUDE_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  const outcome = await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("claude-agent", dir);
    const loadedAssignment = loadAssignmentConfig("one-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: okBackend("cursor"),
        overrides: { backend: "cursor" },
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  assert.equal(outcome.manifest.backend, "cursor");
  assert.equal(outcome.manifest.model, null);
});

test("override: switching from cursor to codex drops the cursor model", async () => {
  const dir = tempDir();
  writeAgent(dir, "cursor-agent", CURSOR_AGENT);
  writeAssignment(dir, "one-work", ONE_TASK_ASSIGNMENT);

  const outcome = await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("cursor-agent", dir);
    const loadedAssignment = loadAssignmentConfig("one-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: okBackend("codex"),
        overrides: { backend: "codex" },
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  assert.equal(outcome.manifest.backend, "codex");
  assert.equal(outcome.manifest.model, null);
});
