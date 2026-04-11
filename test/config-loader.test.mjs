import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentConfigError,
  AgentNotFoundError,
  loadAgentConfig,
  resolveAgentPath,
} from "../dist/config/loader.js";

const MINIMAL = `---
schemaVersion: 1
name: demo
backend: claude
tasks:
  - id: t1
    title: Do the thing
    body: First thing to do.
---
You are an assistant. Plan at {{assignment_path}}.
`;

function writeAgent(baseDir, name, body) {
  const agentDir = join(baseDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "agent.md");
  writeFileSync(path, body);
  return path;
}

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-test-"));
}

test("loadAgentConfig parses a minimal agent.md", () => {
  const dir = tempDir();
  writeAgent(dir, "demo", MINIMAL);

  const loaded = loadAgentConfig("demo", dir);
  assert.equal(loaded.config.name, "demo");
  assert.equal(loaded.config.backend, "claude");
  assert.equal(loaded.config.maxRetries, 3);
  assert.equal(loaded.config.timeoutSec, 3600);
  assert.equal(loaded.config.unrestricted, false);
  assert.equal(loaded.config.tasks.length, 1);
  assert.equal(loaded.config.tasks[0].id, "t1");
  assert.ok(loaded.instructions.includes("{{assignment_path}}"));
});

test("loadAgentConfig throws AgentConfigError on bad frontmatter", () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "bad",
    `---
schemaVersion: 1
backend: claude
tasks:
  - id: t1
    title: First
---
body
`,
  );

  // missing required `name` field
  assert.throws(() => loadAgentConfig("bad", dir), AgentConfigError);
});

test("loadAgentConfig accepts agent with empty tasks array", () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "empty",
    `---
schemaVersion: 1
name: empty
backend: claude
tasks: []
---
body
`,
  );

  const loaded = loadAgentConfig("empty", dir);
  assert.equal(loaded.config.tasks.length, 0);
});

test("loadAgentConfig accepts agent with no tasks field at all", () => {
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
  assert.equal(loaded.config.tasks.length, 0);
});

test("loadAgentConfig throws AgentNotFoundError for missing agent", () => {
  const dir = tempDir();
  assert.throws(() => loadAgentConfig("nope", dir), AgentNotFoundError);
});

test("resolveAgentPath accepts a direct path", () => {
  const dir = tempDir();
  const agentPath = writeAgent(dir, "demo", MINIMAL);

  const resolved = resolveAgentPath(agentPath, dir);
  assert.equal(resolved, agentPath);
});

test("schema rejects duplicate task ids", () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "dup",
    `---
schemaVersion: 1
name: dup
backend: claude
tasks:
  - id: t1
    title: First
  - id: t1
    title: Duplicate
---
body
`,
  );

  assert.throws(() => loadAgentConfig("dup", dir), AgentConfigError);
});
