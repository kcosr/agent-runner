import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  AgentNotFoundError,
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
name: test-agent
backend: claude
model: claude-sonnet-4-6
---
You are a test agent.
`;

const ASSIGNMENT_BODY = `---
schemaVersion: 1
name: test-work
tasks:
  - id: t1
    title: Do the thing
vars:
  repo_path:
    type: string
    required: true
    source: cli
---
Work instructions.
`;

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

    assert.equal(agent.config.name, "test-agent");
    assert.ok(agent.instructions.includes("test agent"));
    assert.equal(assignment.config.name, "test-work");
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
