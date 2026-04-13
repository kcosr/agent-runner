import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { sharedRuntimeEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: run-mgmt-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: run-mgmt-work
maxRetries: 1
tasks:
  - id: t1
    title: First
  - id: t2
    title: Second
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-run-mgmt-"));
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

async function initRun(baseDir) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("run-mgmt-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("run-mgmt-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: {
          id: "mock",
          async invoke() {
            throw new Error("backend should not be invoked during init");
          },
        },
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
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliExpectFail(args, opts = {}) {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    throw new Error("expected CLI to fail");
  } catch (err) {
    if (err.status === undefined) throw err;
    return {
      status: err.status,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
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

test("list runs enumerates current-generation runs across buckets and filters archived by default", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);

  const first = await initRun(dir);
  const second = await initRun(dir);

  patchManifest(first.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T10:00:00.000Z";
    manifest.archivedAt = "2026-04-12T12:00:00.000Z";
  });
  patchManifest(second.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T11:00:00.000Z";
  });

  const otherWorkspaceDir = join(dir, "runs", "other-repo", "oth123");
  mkdirSync(otherWorkspaceDir, { recursive: true });
  const otherManifest = readManifest(second.workspaceDir);
  otherManifest.runId = "oth123";
  otherManifest.workspaceDir = otherWorkspaceDir;
  otherManifest.assignmentPath = join(otherWorkspaceDir, "assignment.md");
  otherManifest.startedAt = "2026-04-12T09:00:00.000Z";
  otherManifest.archivedAt = null;
  writeFileSync(join(otherWorkspaceDir, "run.json"), `${JSON.stringify(otherManifest, null, 2)}\n`);
  writeFileSync(otherManifest.assignmentPath, "# Assignment\n");

  mkdirSync(join(dir, "runs", "broken", "bad111"), { recursive: true });
  writeFileSync(join(dir, "runs", "broken", "bad111", "run.json"), "{ bad json\n");

  const text = runCli(["list", "runs"], { cwd: dir });
  assert.doesNotMatch(text, new RegExp(first.runId));
  assert.match(
    text,
    new RegExp(`^${second.runId} \\[initialized\\] name=<unnamed> 0/2 repo=unknown`, "m"),
  );
  assert.match(text, /^oth123 \[initialized\] name=<unnamed> 0\/2 repo=other-repo/m);

  const includeArchived = runCli(["list", "runs", "--include-archived"], { cwd: dir });
  assert.match(
    includeArchived,
    new RegExp(
      `${first.runId} \\[initialized\\] name=<unnamed> 0/2 .* archived=2026-04-12T12:00:00.000Z`,
    ),
  );

  const jsonOut = runCli(["list", "runs", "--include-archived", "--output-format", "json"], {
    cwd: dir,
  });
  const parsed = JSON.parse(jsonOut);
  assert.deepEqual(
    parsed.map((run) => run.runId),
    [second.runId, first.runId, "oth123"],
  );
  assert.equal(parsed[1].archivedAt, "2026-04-12T12:00:00.000Z");
  assert.deepEqual(parsed[0].capabilities, {
    canArchive: true,
    canUnarchive: false,
    canResume: true,
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
    },
  });
  assert.deepEqual(parsed[1].capabilities, {
    canArchive: false,
    canUnarchive: true,
    canResume: false,
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
    },
  });
});

test("run archive and run unarchive expose idempotent text and json results", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  const archivedText = runCli(["run", "archive", outcome.runId], { cwd: dir });
  assert.match(archivedText, new RegExp(`archived run ${outcome.runId}`));
  assert.ok(readManifest(outcome.workspaceDir).archivedAt);

  const archivedAgainJson = runCli(["run", "archive", outcome.runId, "--output-format", "json"], {
    cwd: dir,
  });
  const archivedAgain = JSON.parse(archivedAgainJson);
  assert.equal(archivedAgain.changed, false);
  assert.ok(archivedAgain.archivedAt);

  const unarchivedText = runCli(["run", "unarchive", outcome.runId], { cwd: dir });
  assert.match(unarchivedText, new RegExp(`unarchived run ${outcome.runId}`));
  assert.equal(readManifest(outcome.workspaceDir).archivedAt, null);

  const unarchivedAgainJson = runCli(
    ["run", "unarchive", outcome.runId, "--output-format", "json"],
    { cwd: dir },
  );
  const unarchivedAgain = JSON.parse(unarchivedAgainJson);
  assert.equal(unarchivedAgain.changed, false);
  assert.equal(unarchivedAgain.archivedAt, null);
});

test("run set-name updates, clears, and preserves reset seed", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  const setText = runCli(["run", "set-name", outcome.runId, "Run naming redesign"], { cwd: dir });
  assert.match(setText, /set name for run .*"Run naming redesign"/);

  let manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.name, "Run naming redesign");
  assert.equal(manifest.resetSeed.name, "Run naming redesign");

  const setAgainJson = runCli(
    ["run", "set-name", outcome.runId, "Run naming redesign", "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(setAgainJson), {
    runId: outcome.runId,
    name: "Run naming redesign",
    changed: false,
  });

  const clearText = runCli(["run", "set-name", outcome.runId, "--clear"], { cwd: dir });
  assert.match(clearText, /cleared name for run/);

  manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.name, null);
  assert.equal(manifest.resetSeed.name, null);

  const clearAgainJson = runCli(
    ["run", "set-name", outcome.runId, "--clear", "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(clearAgainJson), {
    runId: outcome.runId,
    name: null,
    changed: false,
  });
});

test("run set-name validates required args and empty names", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  let result = runCliExpectFail(["run", "set-name"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run set-name requires <id-or-path>/);

  result = runCliExpectFail(["run", "set-name", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run set-name requires <name> or --clear/);

  result = runCliExpectFail(["run", "set-name", outcome.runId, " ", "--output-format", "json"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run set-name: <name> cannot be empty/);
});

test("run archive and run reset reject unrelated --clear flag leakage", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  let result = runCliExpectFail(["run", "archive", outcome.runId, "--clear"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    /run archive only supports <id-or-path>, --connect, and --output-format/,
  );
  assert.match(result.stderr, /--clear/);

  result = runCliExpectFail(["run", "reset", outcome.runId, "--clear"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    /run reset only supports <id-or-path>, --connect, and --output-format/,
  );
  assert.match(result.stderr, /--clear/);
});

test("run archive rejects running runs", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
  });

  const result = runCliExpectFail(["run", "archive", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /cannot archive a running run/);
});

test("run --resume-run rejects archived runs with an unarchive hint", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  runCli(["run", "archive", outcome.runId], { cwd: dir });

  const result = runCliExpectFail(["run", "--resume-run", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, new RegExp(`cannot resume archived run ${outcome.runId}`));
  assert.match(result.stderr, new RegExp(`run unarchive ${outcome.runId}`));
});
