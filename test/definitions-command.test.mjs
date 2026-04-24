import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  listAgents,
  listAssignments,
  listLaunchers,
  loadAgentConfig,
  loadAssignmentConfig,
  loadLauncherConfig,
} from "../packages/core/dist/config/loader.js";
import { withRuntimeRoots } from "./helpers/runtime-paths.mjs";

const AGENT_BODY = `---
schemaVersion: 1
name: __NAME__
backend: claude
model: claude-sonnet-4-6
---
You are a test agent.
`;

const ASSIGNMENT_BODY = `---
schemaVersion: 1
name: __NAME__
tasks:
  - id: t1
    title: Do the thing
vars:
  repo_path:
    type: string
    required: true
    sources: [cli]
---
Work instructions.
`;

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), body.replace("__NAME__", name));
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assignment.md"), body.replace("__NAME__", name));
}

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), body);
}

test("definitions discovery reads from the config root and remains read-only", () =>
  withRuntimeRoots("task-runner-def-test-", ({ configDir, stateDir }) => {
    writeAgent(configDir, "alpha", AGENT_BODY);
    writeAssignment(configDir, "work-a", ASSIGNMENT_BODY);

    const agents = listAgents();
    const assignments = listAssignments();

    assert.deepEqual(
      agents.map((entry) => ({ name: entry.name, root: entry.root })),
      [{ name: "alpha", root: "config" }],
    );
    assert.deepEqual(
      assignments.map((entry) => ({ name: entry.name, root: entry.root })),
      [{ name: "work-a", root: "config" }],
    );
    assert.ok(!existsSync(join(stateDir, "runs")));
  }));

test("definitions discovery does not fall back to cwd-local definitions", () =>
  withRuntimeRoots("task-runner-def-test-", ({ rootDir }) => {
    writeAgent(rootDir, "local-only", AGENT_BODY);
    writeAssignment(rootDir, "local-work", ASSIGNMENT_BODY);

    assert.deepEqual(listAgents(), []);
    assert.deepEqual(listAssignments(), []);
  }));

test("definitions discovery returns sorted names from the config root", () =>
  withRuntimeRoots("task-runner-def-test-", ({ configDir }) => {
    writeAgent(configDir, "zeta", AGENT_BODY);
    writeAgent(configDir, "alpha", AGENT_BODY);
    writeAssignment(configDir, "work-z", ASSIGNMENT_BODY);
    writeAssignment(configDir, "work-a", ASSIGNMENT_BODY);
    writeLauncher(
      configDir,
      "ssh-wrap",
      `schemaVersion: 1
name: ssh-wrap
command: ssh
args: [host, --]
`,
    );

    assert.deepEqual(
      listAgents().map((entry) => entry.name),
      ["alpha", "zeta"],
    );
    assert.deepEqual(
      listAssignments().map((entry) => entry.name),
      ["work-a", "work-z"],
    );
    assert.deepEqual(
      listLaunchers().entries.map((entry) => entry.name),
      ["direct", "ssh-wrap"],
    );
  }));

test("show-style agent and assignment loads resolve bare names from the config root", () =>
  withRuntimeRoots("task-runner-def-test-", ({ rootDir, configDir }) => {
    writeAgent(configDir, "demo", AGENT_BODY);
    writeAssignment(configDir, "demo", ASSIGNMENT_BODY);

    const agent = loadAgentConfig("demo", rootDir);
    const assignment = loadAssignmentConfig("demo", rootDir);

    assert.equal(agent.config.name, "demo");
    assert.ok(agent.instructions.includes("test agent"));
    assert.equal(assignment.config.name, "demo");
    assert.equal(assignment.config.tasks[0].id, "t1");
    assert.ok(assignment.instructions.includes("Work instructions."));
  }));

test("show-style direct path loads remain supported", () =>
  withRuntimeRoots("task-runner-def-test-", ({ configDir }) => {
    writeAgent(configDir, "demo", AGENT_BODY);
    writeAssignment(configDir, "demo", ASSIGNMENT_BODY);
    writeLauncher(
      configDir,
      "demo-launcher",
      `schemaVersion: 1
name: demo-launcher
command: env
args: [FOO=bar]
`,
    );

    const agentPath = join(configDir, "agents", "demo", "agent.md");
    const assignmentPath = join(configDir, "assignments", "demo", "assignment.md");
    const launcherPath = join(configDir, "launchers", "demo-launcher.yaml");

    assert.equal(loadAgentConfig(agentPath).sourcePath, agentPath);
    assert.equal(loadAssignmentConfig(assignmentPath).sourcePath, assignmentPath);
    assert.equal(loadLauncherConfig(launcherPath).sourcePath, launcherPath);
  }));

test("show-style bare-name loads accept slashful canonical ids for nested agents and assignments", () =>
  withRuntimeRoots("task-runner-def-test-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "reviewers/code",
      `---
schemaVersion: 1
name: reviewers/code
backend: claude
---
Nested reviewer.
`,
    );
    writeAssignment(
      configDir,
      "review/reuse",
      `---
schemaVersion: 1
name: review/reuse
tasks:
  - id: nested-task
    title: Nested task
---
Nested assignment.
`,
    );

    const agent = loadAgentConfig("reviewers/code", rootDir);
    const assignment = loadAssignmentConfig("review/reuse", rootDir);

    assert.equal(agent.config.name, "reviewers/code");
    assert.equal(assignment.config.name, "review/reuse");
    assert.deepEqual(
      listAgents().map((entry) => entry.name),
      ["reviewers/code"],
    );
    assert.deepEqual(
      listAssignments().map((entry) => entry.name),
      ["review/reuse"],
    );
  }));

test("assignment var schema accepts `sources` and rejects legacy or malformed source definitions", () =>
  withRuntimeRoots("task-runner-def-test-", ({ configDir, rootDir }) => {
    writeAssignment(
      configDir,
      "sources-valid",
      `---
schemaVersion: 1
name: sources-valid
vars:
  repo_path:
    type: string
    required: true
    sources: [cli, parent]
tasks:
  - id: t1
    title: First
---
Valid.
`,
    );
    assert.deepEqual(loadAssignmentConfig("sources-valid", rootDir).config.vars.repo_path.sources, [
      "cli",
      "parent",
    ]);

    writeAssignment(
      configDir,
      "sources-legacy",
      `---
schemaVersion: 1
name: sources-legacy
vars:
  repo_path:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: First
---
Legacy.
`,
    );
    assert.throws(() => loadAssignmentConfig("sources-legacy", rootDir), AssignmentConfigError);

    writeAssignment(
      configDir,
      "sources-duplicate",
      `---
schemaVersion: 1
name: sources-duplicate
vars:
  repo_path:
    type: string
    required: true
    sources: [cli, cli]
tasks:
  - id: t1
    title: First
---
Duplicate.
`,
    );
    assert.throws(() => loadAssignmentConfig("sources-duplicate", rootDir), AssignmentConfigError);

    writeAssignment(
      configDir,
      "sources-empty",
      `---
schemaVersion: 1
name: sources-empty
vars:
  repo_path:
    type: string
    required: true
    sources: []
tasks:
  - id: t1
    title: First
---
Empty.
`,
    );
    assert.throws(() => loadAssignmentConfig("sources-empty", rootDir), AssignmentConfigError);
  }));

test("missing bare-name loads report config-root searched paths", () =>
  withRuntimeRoots("task-runner-def-test-", ({ rootDir, configDir }) => {
    assert.throws(
      () => loadAgentConfig("nope", rootDir),
      (error) => {
        assert.ok(error instanceof AgentNotFoundError);
        assert.deepEqual(error.searched, [join(configDir, "agents", "nope", "agent.md")]);
        return true;
      },
    );

    assert.throws(
      () => loadAssignmentConfig("nope", rootDir),
      (error) => {
        assert.ok(error instanceof AssignmentNotFoundError);
        assert.deepEqual(error.searched, [join(configDir, "assignments", "nope", "assignment.md")]);
        return true;
      },
    );
  }));
