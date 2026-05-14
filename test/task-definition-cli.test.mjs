import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { withRuntimeRoots } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

function runCli(args, opts = {}) {
  return spawnSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    encoding: "utf8",
  });
}

function assertCliOk(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.error, undefined);
}

function writeTask(baseDir, name, body) {
  const path = join(baseDir, "tasks", `${name}.md`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body);
  return path;
}

function writeAgent(baseDir, name, body) {
  const path = join(baseDir, "agents", name, "agent.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.replaceAll("__NAME__", name));
  return path;
}

function writeAssignment(baseDir, name, body) {
  const path = join(baseDir, "assignments", name, "assignment.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.replaceAll("__NAME__", name));
  return path;
}

function writeLauncher(baseDir, name, body) {
  const path = join(baseDir, "launchers", `${name}.yaml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.replaceAll("__NAME__", name));
  return path;
}

function writeEnvironment(baseDir, name, body) {
  const path = join(baseDir, "environments", `${name}.yaml`);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.replaceAll("__NAME__", name));
  return path;
}

test("CLI list tasks renders text and json task definition lists", () =>
  withRuntimeRoots("agent-runner-task-def-cli-", ({ rootDir, configDir }) => {
    const orientPath = writeTask(
      configDir,
      "orient",
      `---
schemaVersion: 1
title: Orient repo
---
Read README.md.
`,
    );
    const reviewPath = writeTask(
      configDir,
      "review/architecture",
      `---
schemaVersion: 1
title: Architecture review
---
Review module boundaries.
`,
    );

    const text = runCli(["list", "tasks"], { cwd: rootDir });
    assertCliOk(text);
    assert.equal(text.stderr, "");
    assert.equal(text.stdout, "  orient\n  review/architecture\n");

    const json = runCli(["list", "tasks", "--output-format", "json"], { cwd: rootDir });
    assertCliOk(json);
    assert.equal(json.stderr, "");
    assert.deepEqual(JSON.parse(json.stdout), {
      kind: "task",
      entries: [
        { name: "orient", path: orientPath, root: "config" },
        { name: "review/architecture", path: reviewPath, root: "config" },
      ],
      warnings: [],
    });
  }));

test("CLI show task renders text and json task definition details", () =>
  withRuntimeRoots("agent-runner-task-def-cli-", ({ rootDir, configDir }) => {
    const taskPath = writeTask(
      configDir,
      "deploy/check",
      `---
schemaVersion: 1
id: deploy/check
title: Check deployment
hooks:
  - builtin: require-children-success
---
Verify deployment status.
`,
    );

    const text = runCli(["show", "task", "deploy/check"], { cwd: rootDir });
    assertCliOk(text);
    assert.equal(text.stderr, "");
    assert.equal(
      text.stdout,
      `Task: deploy/check
  title:        Check deployment
  hooks:        1
    - builtin: require-children-success
  source:       ${taskPath}

Verify deployment status.
`,
    );

    const json = runCli(["show", "task", "deploy/check", "--output-format", "json"], {
      cwd: rootDir,
    });
    assertCliOk(json);
    assert.equal(json.stderr, "");
    assert.deepEqual(JSON.parse(json.stdout), {
      kind: "task",
      task: {
        id: "deploy/check",
        title: "Check deployment",
        body: "Verify deployment status.",
        hooks: [{ builtin: "require-children-success" }],
      },
      sourcePath: taskPath,
    });
  }));

test("CLI list tasks warns and skips invalid config-root task definitions", () =>
  withRuntimeRoots("agent-runner-task-def-cli-", ({ rootDir, configDir }) => {
    writeTask(
      configDir,
      "good",
      `---
schemaVersion: 1
title: Good task
---
Good body.
`,
    );
    const badPath = writeTask(
      configDir,
      "review/bad",
      `---
schemaVersion: 1
id: review/wrong
title: Bad task
---
Bad body.
`,
    );

    const result = runCli(["list", "tasks"], { cwd: rootDir });

    assertCliOk(result);
    assert.equal(result.stdout, "  good\n");
    assert.ok(result.stderr.includes(badPath));
    assert.match(result.stderr, /agent-runner: warning: Invalid task config/);
    assert.match(result.stderr, /must match canonical id "review\/bad"/);
    assert.match(result.stderr, /definition skipped/);

    const json = runCli(["list", "tasks", "--output-format", "json"], { cwd: rootDir });
    assertCliOk(json);
    assert.equal(json.stderr, "");
    const parsed = JSON.parse(json.stdout);
    assert.equal(parsed.kind, "task");
    assert.deepEqual(
      parsed.entries.map((entry) => entry.name),
      ["good"],
    );
    assert.equal(parsed.warnings.length, 1);
    assert.ok(parsed.warnings[0].includes(badPath));
    assert.match(parsed.warnings[0], /must match canonical id "review\/bad"/);
  }));

test("CLI show task reports usage and missing task failures", () =>
  withRuntimeRoots("agent-runner-task-def-cli-", ({ rootDir, configDir }) => {
    const missingTarget = runCli(["show", "task"], { cwd: rootDir });
    assert.equal(missingTarget.status, 3);
    assert.equal(missingTarget.stdout, "");
    assert.match(missingTarget.stderr, /show task requires a name or path/);
    assert.match(missingTarget.stderr, /show <agent\|assignment\|launcher\|environment\|task>/);

    const missingTask = runCli(["show", "task", "missing/task"], { cwd: rootDir });
    assert.equal(missingTask.status, 3);
    assert.equal(missingTask.stdout, "");
    assert.match(missingTask.stderr, /Task not found: missing\/task/);
    assert.ok(missingTask.stderr.includes(join(configDir, "tasks", "missing", "task.md")));

    const extraPositional = runCli(["show", "task", "missing/task", "extra"], { cwd: rootDir });
    assert.equal(extraPositional.status, 3);
    assert.equal(extraPositional.stdout, "");
    assert.match(extraPositional.stderr, /show task takes exactly one name or path/);

    const unsupportedFlag = runCli(["show", "task", "missing/task", "--cwd", rootDir], {
      cwd: rootDir,
    });
    assert.equal(unsupportedFlag.status, 3);
    assert.equal(unsupportedFlag.stdout, "");
    assert.match(
      unsupportedFlag.stderr,
      /show task only supports <name\|path>, --connect, and --output-format/,
    );
  }));

test("CLI definition renderer handles existing agent, assignment, launcher, and environment details", () =>
  withRuntimeRoots("agent-runner-task-def-cli-", ({ rootDir, configDir }) => {
    const agentPath = writeAgent(
      configDir,
      "renderer-agent",
      `---
schemaVersion: 1
name: __NAME__
backend: codex
model: gpt-5.5
executionEnvironment: renderer-environment
---
Review implementation details.
`,
    );
    const assignmentPath = writeAssignment(
      configDir,
      "review-work",
      `---
schemaVersion: 1
name: __NAME__
tasks:
  - id: first
    title: First task
---
Review the work.
`,
    );
    const launcherPath = writeLauncher(
      configDir,
      "renderer-launcher",
      `schemaVersion: 1
name: __NAME__
command: ssh
args: [worker, run]
`,
    );
    const environmentPath = writeEnvironment(
      configDir,
      "renderer-environment",
      `schemaVersion: 1
name: __NAME__
kind: container
mode: existing
engine: podman
cwd: /workspace
container: renderer-worker
`,
    );

    const agent = runCli(["show", "agent", "renderer-agent"], { cwd: rootDir });
    assertCliOk(agent);
    assert.equal(agent.stderr, "");
    assert.match(agent.stdout, /Agent: renderer-agent/);
    assert.match(agent.stdout, /backend:\s+codex/);
    assert.match(agent.stdout, /model:\s+gpt-5\.5/);
    assert.match(agent.stdout, /environment:\s+renderer-environment/);
    assert.ok(agent.stdout.includes(`source:       ${agentPath}`));
    assert.match(agent.stdout, /Review implementation details\./);

    const assignment = runCli(["show", "assignment", `./${relative(rootDir, assignmentPath)}`], {
      cwd: rootDir,
    });
    assertCliOk(assignment);
    assert.equal(assignment.stderr, "");
    assert.match(assignment.stdout, /Assignment: review-work/);
    assert.match(assignment.stdout, /tasks:\s+1/);
    assert.match(assignment.stdout, /- first: First task/);
    assert.match(assignment.stdout, /Review the work\./);

    const launcher = runCli(["show", "launcher", "renderer-launcher"], { cwd: rootDir });
    assertCliOk(launcher);
    assert.equal(launcher.stderr, "");
    assert.match(launcher.stdout, /Launcher: renderer-launcher/);
    assert.match(launcher.stdout, /kind:\s+prefix/);
    assert.match(launcher.stdout, /command:\s+ssh/);
    assert.match(launcher.stdout, /args:\s+worker run/);
    assert.ok(launcher.stdout.includes(`source:       ${launcherPath}`));

    const environments = runCli(["list", "environments"], { cwd: rootDir });
    assertCliOk(environments);
    assert.equal(environments.stderr, "");
    assert.equal(environments.stdout, "  renderer-environment\n");

    const environment = runCli(["show", "environment", "renderer-environment"], {
      cwd: rootDir,
    });
    assertCliOk(environment);
    assert.equal(environment.stderr, "");
    assert.match(environment.stdout, /Environment: renderer-environment/);
    assert.match(environment.stdout, /kind:\s+container/);
    assert.match(environment.stdout, /mode:\s+existing/);
    assert.match(environment.stdout, /engine:\s+podman/);
    assert.match(environment.stdout, /container:\s+renderer-worker/);
    assert.ok(environment.stdout.includes(`source:       ${environmentPath}`));
  }));
