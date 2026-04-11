import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
  listAgents,
  listAssignments,
  loadAgentConfig,
  loadAssignmentConfig,
  resolveAgentPath,
  resolveAssignmentPath,
} from "../dist/config/loader.js";

const MINIMAL_AGENT = `---
schemaVersion: 1
name: demo
backend: claude
---
You are an assistant.
`;

const MINIMAL_ASSIGNMENT = `---
schemaVersion: 1
name: demo-work
tasks:
  - id: t1
    title: Do the thing
    body: First thing to do.
---
Work on the repo. Plan at {{assignment_path}}.
`;

function writeAgent(baseDir, name, body) {
  const agentDir = join(baseDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "agent.md");
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

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-test-"));
}

test("loadAgentConfig parses a minimal agent.md", () => {
  const dir = tempDir();
  writeAgent(dir, "demo", MINIMAL_AGENT);

  const loaded = loadAgentConfig("demo", dir);
  assert.equal(loaded.config.name, "demo");
  assert.equal(loaded.config.backend, "claude");
  assert.equal(loaded.config.timeoutSec, 3600);
  assert.equal(loaded.config.unrestricted, false);
  assert.ok(!("maxRetries" in loaded.config), "maxRetries moved to assignment schema");
  assert.ok(loaded.instructions.includes("You are an assistant."));
});

test("loadAgentConfig throws AgentConfigError on bad frontmatter", () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "bad",
    `---
schemaVersion: 1
backend: claude
---
body
`,
  );

  // missing required `name` field
  assert.throws(() => loadAgentConfig("bad", dir), AgentConfigError);
});

test("loadAgentConfig silently drops `tasks` (which belongs on assignments)", () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "with-tasks",
    `---
schemaVersion: 1
name: with-tasks
backend: claude
tasks:
  - id: t1
    title: First
---
body
`,
  );

  // `tasks` moved to the assignment schema. The agent schema uses zod's default
  // strip behavior, so unknown keys are quietly dropped on load.
  const loaded = loadAgentConfig("with-tasks", dir);
  assert.equal(loaded.config.name, "with-tasks");
  assert.ok(!("tasks" in loaded.config), "tasks stripped from agent config");
});

test("loadAgentConfig accepts agent with no tasks/vars/message fields", () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "notasks",
    `---
schemaVersion: 1
name: notasks
backend: claude
---
body
`,
  );

  const loaded = loadAgentConfig("notasks", dir);
  assert.equal(loaded.config.name, "notasks");
});

test("loadAgentConfig throws AgentNotFoundError for missing agent", () => {
  const dir = tempDir();
  assert.throws(() => loadAgentConfig("nope", dir), AgentNotFoundError);
});

test("resolveAgentPath accepts a direct path", () => {
  const dir = tempDir();
  const agentPath = writeAgent(dir, "demo", MINIMAL_AGENT);

  const resolved = resolveAgentPath(agentPath, dir);
  assert.equal(resolved, agentPath);
});

test("loadAssignmentConfig parses a minimal assignment.md", () => {
  const dir = tempDir();
  writeAssignment(dir, "demo-work", MINIMAL_ASSIGNMENT);

  const loaded = loadAssignmentConfig("demo-work", dir);
  assert.equal(loaded.config.name, "demo-work");
  assert.equal(loaded.config.tasks.length, 1);
  assert.equal(loaded.config.tasks[0].id, "t1");
  assert.equal(loaded.config.maxRetries, 3, "maxRetries defaults to 3 on assignment");
  assert.ok(loaded.instructions.includes("{{assignment_path}}"));
});

test("loadAssignmentConfig throws AssignmentNotFoundError for missing assignment", () => {
  const dir = tempDir();
  assert.throws(() => loadAssignmentConfig("nope-work", dir), AssignmentNotFoundError);
});

test("resolveAssignmentPath accepts a direct path", () => {
  const dir = tempDir();
  const assignmentPath = writeAssignment(dir, "demo-work", MINIMAL_ASSIGNMENT);

  const resolved = resolveAssignmentPath(assignmentPath, dir);
  assert.equal(resolved, assignmentPath);
});

test("assignment schema rejects duplicate task ids", () => {
  const dir = tempDir();
  writeAssignment(
    dir,
    "dup",
    `---
schemaVersion: 1
name: dup
tasks:
  - id: t1
    title: First
  - id: t1
    title: Duplicate
---
body
`,
  );

  assert.throws(() => loadAssignmentConfig("dup", dir), AssignmentConfigError);
});

test("assignment schema rejects multiline task titles", () => {
  const dir = tempDir();
  writeAssignment(
    dir,
    "multiline-title",
    `---
schemaVersion: 1
name: multiline-title
tasks:
  - id: t1
    title: |-
      Line 1
      Line 2
---
body
`,
  );

  assert.throws(() => loadAssignmentConfig("multiline-title", dir), AssignmentConfigError);
});

test("assignment schema rejects incompatible var defaults", () => {
  const dir = tempDir();
  writeAssignment(
    dir,
    "bad-default",
    `---
schemaVersion: 1
name: bad-default
vars:
  retries:
    type: number
    default: nope
---
body
`,
  );

  assert.throws(() => loadAssignmentConfig("bad-default", dir), AssignmentConfigError);
});

// ── catalog / list tests ────────────────────────────────────────────

test("listAgents discovers local agents", () => {
  const dir = tempDir();
  writeAgent(dir, "alpha", MINIMAL_AGENT);
  writeAgent(dir, "beta", MINIMAL_AGENT);

  const entries = listAgents(dir);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("alpha"));
  assert.ok(names.includes("beta"));
  assert.equal(entries[0].root, "local");
});

test("listAssignments discovers local assignments", () => {
  const dir = tempDir();
  writeAssignment(dir, "work-a", MINIMAL_ASSIGNMENT);
  writeAssignment(dir, "work-b", MINIMAL_ASSIGNMENT);

  const entries = listAssignments(dir);
  const names = entries.map((e) => e.name);
  assert.ok(names.includes("work-a"));
  assert.ok(names.includes("work-b"));
});

test("listAgents returns sorted names", () => {
  const dir = tempDir();
  writeAgent(dir, "zeta", MINIMAL_AGENT);
  writeAgent(dir, "alpha", MINIMAL_AGENT);
  writeAgent(dir, "mid", MINIMAL_AGENT);

  const entries = listAgents(dir);
  const names = entries.map((e) => e.name);
  assert.deepEqual(names, ["alpha", "mid", "zeta"]);
});

test("listAgents returns empty array when no agents exist", () => {
  const dir = tempDir();
  const entries = listAgents(dir);
  assert.deepEqual(entries, []);
});

test("listAssignments returns empty array when no assignments exist", () => {
  const dir = tempDir();
  const entries = listAssignments(dir);
  assert.deepEqual(entries, []);
});

test("listAgents skips directories without agent.md", () => {
  const dir = tempDir();
  writeAgent(dir, "real", MINIMAL_AGENT);
  mkdirSync(join(dir, "agents", "empty"), { recursive: true });

  const entries = listAgents(dir);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].name, "real");
});

test("listAgents local root shadows global root for same name", () => {
  const dir = tempDir();
  const globalDir = tempDir();
  writeAgent(dir, "shared", MINIMAL_AGENT);
  writeAgent(globalDir, "shared", MINIMAL_AGENT);
  writeAgent(globalDir, "global-only", MINIMAL_AGENT);

  const origEnv = process.env.TASK_RUNNER_HOME;
  try {
    process.env.TASK_RUNNER_HOME = globalDir;
    const entries = listAgents(dir);
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("shared"));
    assert.ok(names.includes("global-only"));
    const shared = entries.find((e) => e.name === "shared");
    assert.equal(shared.root, "local");
    const globalOnly = entries.find((e) => e.name === "global-only");
    assert.equal(globalOnly.root, "global");
  } finally {
    if (origEnv === undefined) {
      process.env.TASK_RUNNER_HOME = undefined;
    } else {
      process.env.TASK_RUNNER_HOME = origEnv;
    }
  }
});

test("listAgents throws DefinitionListError when agents directory is unreadable", () => {
  const dir = tempDir();
  const agentsDir = join(dir, "agents");
  mkdirSync(agentsDir, { recursive: true });
  writeAgent(dir, "visible", MINIMAL_AGENT);
  chmodSync(agentsDir, 0o000);
  try {
    assert.throws(() => listAgents(dir), DefinitionListError);
  } finally {
    chmodSync(agentsDir, 0o755);
  }
});
