import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../dist/cli/parse-args.js";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { LockedFieldError, runAgent } from "../dist/runner/run-loop.js";

const CLAUDE_AGENT = `---
schemaVersion: 1
name: claude-agent
backend: claude
model: claude-sonnet-4-6
effort: medium
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

function editStatus(content, taskId, newStatus) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${newStatus}`);
  return content.slice(0, start) + updated + content.slice(end);
}

const okBackend = (id) => ({
  id,
  async invoke(ctx) {
    const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
    if (match) {
      const absPlan = `./${match[0]}`;
      const plan = readFileSync(absPlan, "utf8");
      writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
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
}

test("parseArgs: --backend accepts claude and codex", () => {
  const a = parseArgs(["node", "task-runner", "run", "--agent", "x", "--backend", "claude"]);
  assert.equal(a.backend, "claude");
  const b = parseArgs(["node", "task-runner", "run", "--agent", "x", "--backend", "codex"]);
  assert.equal(b.backend, "codex");
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
