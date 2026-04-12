import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/runner/run-loop.js";
import { sharedRuntimeEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: task-mode-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const FILE_ASSIGNMENT = `---
schemaVersion: 1
name: file-work
tasks:
  - id: t1
    title: First
    body: Do thing one.
---
Work from the assignment file.
`;

const CLI_ASSIGNMENT = `---
schemaVersion: 1
name: cli-work
taskMode: cli
tasks:
  - id: t1
    title: First
    body: Do thing one.
---
Work from task CLI commands.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-taskmode-"));
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

async function initRun(baseDir, assignmentName) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("task-mode-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig(assignmentName, baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: { id: "mock", invoke: async () => ({}) },
        initialize: true,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function runCli(args, opts = {}) {
  return spawnSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
    encoding: "utf8",
  });
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = readManifest(workspaceDir);
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("taskMode=cli init prompt uses task CLI workflow instead of assignment-path workflow", async () => {
  const dir = tempDir();
  writeAgent(dir, "task-mode-agent", AGENT);
  writeAssignment(dir, "cli-work", CLI_ASSIGNMENT);

  const outcome = await initRun(dir, "cli-work");
  const prompt = outcome.manifest.pendingPrompt ?? "";

  assert.equal(outcome.manifest.taskMode, "cli");
  assert.match(prompt, new RegExp(`task list ${outcome.runId}`));
  assert.match(prompt, new RegExp(`task show ${outcome.runId}`));
  assert.match(prompt, new RegExp(`task set ${outcome.runId}`));
  assert.match(prompt, new RegExp(`task append-notes ${outcome.runId}`));
  assert.match(prompt, new RegExp(`status ${outcome.runId}`));
  assert.match(prompt, new RegExp(outcome.manifest.cwd));
  assert.doesNotMatch(prompt, /Your assignment is at/);
  assert.doesNotMatch(
    prompt,
    new RegExp(outcome.assignmentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
  );
});

test("taskMode omitted defaults to file behavior", async () => {
  const dir = tempDir();
  writeAgent(dir, "task-mode-agent", AGENT);
  writeAssignment(dir, "file-work", FILE_ASSIGNMENT);

  const outcome = await initRun(dir, "file-work");
  const prompt = outcome.manifest.pendingPrompt ?? "";

  assert.equal(outcome.manifest.taskMode, "file");
  assert.match(prompt, /Your assignment is at/);
  assert.match(prompt, new RegExp(outcome.assignmentPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("status on a running cli-mode run reads canonical task state and explains the mode", async () => {
  const dir = tempDir();
  writeAgent(dir, "task-mode-agent", AGENT);
  writeAssignment(dir, "cli-work", CLI_ASSIGNMENT);
  const outcome = await initRun(dir, "cli-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "cli";
    manifest.finalTasks.t1.status = "in_progress";
    manifest.finalTasks.t1.notes = "Canonical note";
  });

  let plan = readFileSync(outcome.assignmentPath, "utf8");
  plan = plan.replace(/\*\*Status:\*\* pending/, "**Status:** completed");
  plan = plan.replace("<!-- notes:start -->", "<!-- notes:start -->\nDrifted note");
  writeFileSync(outcome.assignmentPath, plan, "utf8");

  const res = runCli(["status", outcome.runId], { cwd: dir });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /- t1 — First \[in_progress\]/);
  assert.match(res.stdout, /Canonical note/);
  assert.match(res.stdout, /canonical run\.json task state/);
  assert.doesNotMatch(res.stdout, /Drifted note/);
});

test("status on an older manifest with no taskMode still behaves like file mode", async () => {
  const dir = tempDir();
  writeAgent(dir, "task-mode-agent", AGENT);
  writeAssignment(dir, "file-work", FILE_ASSIGNMENT);
  const outcome = await initRun(dir, "file-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = undefined;
  });

  let plan = readFileSync(outcome.assignmentPath, "utf8");
  plan = plan.replace(/\*\*Status:\*\* pending/, "**Status:** completed");
  writeFileSync(outcome.assignmentPath, plan, "utf8");

  const res = runCli(
    ["status", outcome.runId, "--output-format", "json", "--field", "finalTasks"],
    { cwd: dir },
  );
  assert.equal(res.status, 0);
  const parsed = JSON.parse(res.stdout);
  assert.equal(parsed.finalTasks.t1.status, "completed");
});

test("task-state persistence serializes concurrent cli-mode writes and keeps run.json and assignment.md coherent", async () => {
  const dir = tempDir();
  writeAgent(dir, "task-mode-agent", AGENT);
  writeAssignment(dir, "cli-work", CLI_ASSIGNMENT);
  const outcome = await initRun(dir, "cli-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.taskMode = "cli";
  });

  const locker = spawn(
    "node",
    [
      "--input-type=module",
      "-e",
      `
        import { withTaskStateLock } from ${JSON.stringify(
          resolvePath(new URL("../dist/runner/workspace-state.js", import.meta.url).pathname),
        )};
        const buf = new Int32Array(new SharedArrayBuffer(4));
        withTaskStateLock(${JSON.stringify(outcome.workspaceDir)}, () => {
          console.log("locked");
          Atomics.wait(buf, 0, 0, 250);
        });
      `,
    ],
    {
      cwd: dir,
      env: { ...process.env, ...sharedRuntimeEnv(dir) },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  await once(locker.stdout, "data");
  const started = Date.now();
  const result = runCli(
    ["task", "append-notes", outcome.runId, "t1", "--text", "Serialized write"],
    {
      cwd: dir,
    },
  );
  const elapsed = Date.now() - started;
  await once(locker, "exit");

  assert.equal(result.status, 0);
  assert.ok(elapsed >= 150, `expected lock wait, saw ${elapsed}ms`);

  const manifest = readManifest(outcome.workspaceDir);
  const planText = readFileSync(outcome.assignmentPath, "utf8");
  assert.equal(manifest.finalTasks.t1.notes, "Serialized write");
  assert.match(planText, /Serialized write/);
});
