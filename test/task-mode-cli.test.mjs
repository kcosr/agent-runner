import { strict as assert } from "node:assert";
import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { sharedRuntimeEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: brief-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: brief-work
tasks:
  - id: t1
    title: First
    body: Do thing one.
---
Work from task CLI commands.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-brief-"));
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
    const loaded = loadAgentConfig("brief-agent", baseDir);
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

function spawnLockedManifestWriter(dir, workspaceDir, mutateSource) {
  return spawn(
    "node",
    [
      "--input-type=module",
      "-e",
      `
        import { readFileSync, writeFileSync } from "node:fs";
        import { join } from "node:path";
        import { withTaskStateLock } from ${JSON.stringify(
          resolvePath(
            new URL("../packages/core/dist/core/run/workspace-state.js", import.meta.url).pathname,
          ),
        )};

        const buf = new Int32Array(new SharedArrayBuffer(4));
        withTaskStateLock(${JSON.stringify(workspaceDir)}, () => {
          const manifestPath = join(${JSON.stringify(workspaceDir)}, "run.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          ${mutateSource}
          writeFileSync(manifestPath, \`\${JSON.stringify(manifest, null, 2)}\\n\`);
          console.log("written");
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
}

test("init stores a canonical brief and does not generate workspace assignment.md", async () => {
  const dir = tempDir();
  writeAgent(dir, "brief-agent", AGENT);
  writeAssignment(dir, "brief-work", ASSIGNMENT);

  const outcome = await initRun(dir, "brief-work");
  const brief = outcome.manifest.brief;

  assert.match(brief, new RegExp(`task list ${outcome.runId}`));
  assert.match(brief, new RegExp(`task show ${outcome.runId}`));
  assert.match(brief, new RegExp(`task set ${outcome.runId}`));
  assert.match(brief, new RegExp(`task append-notes ${outcome.runId}`));
  assert.match(brief, new RegExp(`status ${outcome.runId}`));
  assert.ok(!existsSync(outcome.assignmentPath), "workspace assignment.md is not generated");
  assert.ok(existsSync(join(outcome.workspaceDir, "assignment-seed.md")), "seed file captured");
});

test("brief command prints the stored handoff and rejects path targets", async () => {
  const dir = tempDir();
  writeAgent(dir, "brief-agent", AGENT);
  writeAssignment(dir, "brief-work", ASSIGNMENT);
  const outcome = await initRun(dir, "brief-work");

  const ok = runCli(["brief", outcome.runId], { cwd: dir });
  assert.equal(ok.status, 0);
  assert.match(ok.stdout, new RegExp(`task list ${outcome.runId}`));

  const bad = runCli(["brief", outcome.workspaceDir], { cwd: dir });
  assert.equal(bad.status, 3);
  assert.match(bad.stderr, /brief accepts a run id, not a path/);
});

test("status on a running run reads canonical task state", async () => {
  const dir = tempDir();
  writeAgent(dir, "brief-agent", AGENT);
  writeAssignment(dir, "brief-work", ASSIGNMENT);
  const outcome = await initRun(dir, "brief-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.finalTasks.t1.status = "in_progress";
    manifest.finalTasks.t1.notes = "Canonical note";
  });

  const res = runCli(["status", outcome.runId], { cwd: dir });
  assert.equal(res.status, 0);
  assert.match(res.stdout, /- t1 — First \[in_progress\]/);
  assert.match(res.stdout, /Canonical note/);
  assert.match(res.stdout, /canonical run\.json task state/);
});

test("task-state persistence serializes concurrent writes into run.json only", async () => {
  const dir = tempDir();
  writeAgent(dir, "brief-agent", AGENT);
  writeAssignment(dir, "brief-work", ASSIGNMENT);
  const outcome = await initRun(dir, "brief-work");

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
  });

  const locker = spawn(
    "node",
    [
      "--input-type=module",
      "-e",
      `
        import { withTaskStateLock } from ${JSON.stringify(
          resolvePath(
            new URL("../packages/core/dist/core/run/workspace-state.js", import.meta.url).pathname,
          ),
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
  assert.equal(manifest.finalTasks.t1.notes, "Serialized write");
  assert.ok(!existsSync(outcome.assignmentPath), "no workspace assignment.md was created");
});

test("status and task commands wait for the task-state lock and read fresh snapshots", async () => {
  const dir = tempDir();
  writeAgent(dir, "brief-agent", AGENT);
  writeAssignment(dir, "brief-work", ASSIGNMENT);
  const outcome = await initRun(dir, "brief-work");

  const statusLocker = spawnLockedManifestWriter(
    dir,
    outcome.workspaceDir,
    `
      manifest.tasksCompleted = 1;
      manifest.finalTasks.t1.status = "completed";
      manifest.finalTasks.t1.notes = "Fresh from locked write";
    `,
  );
  await once(statusLocker.stdout, "data");

  const statusStarted = Date.now();
  const statusResult = runCli(["status", outcome.runId], { cwd: dir });
  const statusElapsed = Date.now() - statusStarted;
  await once(statusLocker, "exit");

  assert.equal(statusResult.status, 0);
  assert.ok(statusElapsed >= 150, `expected status to wait for the lock, saw ${statusElapsed}ms`);
  assert.match(statusResult.stdout, /Tasks completed: 1\/1/);
  assert.match(statusResult.stdout, /First \[completed\]/);
  assert.match(statusResult.stdout, /Fresh from locked write/);

  const showLocker = spawnLockedManifestWriter(
    dir,
    outcome.workspaceDir,
    `
      manifest.finalTasks.t1.notes = "Visible after show wait";
    `,
  );
  await once(showLocker.stdout, "data");
  const showStarted = Date.now();
  const showResult = runCli(["task", "show", outcome.runId, "t1"], { cwd: dir });
  const showElapsed = Date.now() - showStarted;
  await once(showLocker, "exit");

  assert.equal(showResult.status, 0);
  assert.ok(showElapsed >= 150, `expected task show to wait for the lock, saw ${showElapsed}ms`);
  assert.match(showResult.stdout, /^status: completed$/m);
  assert.match(showResult.stdout, /notes:\nVisible after show wait\n$/);
});
