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

function writeAssignment(baseDir, name, body) {
  const path = join(baseDir, "assignments", name, "assignment.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body.replaceAll("__NAME__", name));
  return path;
}

test("CLI list tasks renders text and json task definition lists", () =>
  withRuntimeRoots("task-runner-task-def-cli-", ({ rootDir, configDir }) => {
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
  withRuntimeRoots("task-runner-task-def-cli-", ({ rootDir, configDir }) => {
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
  withRuntimeRoots("task-runner-task-def-cli-", ({ rootDir, configDir }) => {
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
    assert.match(result.stderr, /task-runner: warning: Invalid task config/);
    assert.match(result.stderr, /must match canonical id "review\/bad"/);
    assert.match(result.stderr, /definition skipped/);
  }));

test("CLI show task reports usage and missing task failures", () =>
  withRuntimeRoots("task-runner-task-def-cli-", ({ rootDir, configDir }) => {
    const missingTarget = runCli(["show", "task"], { cwd: rootDir });
    assert.equal(missingTarget.status, 3);
    assert.equal(missingTarget.stdout, "");
    assert.match(missingTarget.stderr, /show task requires a name or path/);
    assert.match(missingTarget.stderr, /show <agent\|assignment\|launcher\|task>/);

    const missingTask = runCli(["show", "task", "missing/task"], { cwd: rootDir });
    assert.equal(missingTask.status, 3);
    assert.equal(missingTask.stdout, "");
    assert.match(missingTask.stderr, /Task not found: missing\/task/);
    assert.ok(missingTask.stderr.includes(join(configDir, "tasks", "missing", "task.md")));
  }));

test("CLI definition renderer still handles existing assignment details", () =>
  withRuntimeRoots("task-runner-task-def-cli-", ({ rootDir, configDir }) => {
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
    const target = `./${relative(rootDir, assignmentPath)}`;

    const result = runCli(["show", "assignment", target], { cwd: rootDir });

    assertCliOk(result);
    assert.equal(result.stderr, "");
    assert.match(result.stdout, /Assignment: review-work/);
    assert.match(result.stdout, /tasks:\s+1/);
    assert.match(result.stdout, /- first: First task/);
    assert.match(result.stdout, /Review the work\./);
  }));
