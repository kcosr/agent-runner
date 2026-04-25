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

const PASSIVE_AGENT = `---
schemaVersion: 1
name: run-mgmt-passive-agent
backend: passive
---
Passive agent.
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

async function initRun(baseDir, agentName = "run-mgmt-agent") {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    const loadedAssignment = loadAssignmentConfig("run-mgmt-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: {
          id: loaded.config.backend,
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

test("list runs scopes to cwd by default and supports explicit cwd, repo, global, and archived filters", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const otherCwd = join(dir, "other-cwd");
  mkdirSync(otherCwd, { recursive: true });

  const first = await initRun(dir);
  const second = await initRun(dir);

  patchManifest(first.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T10:00:00.000Z";
    manifest.archivedAt = "2026-04-12T12:00:00.000Z";
  });
  patchManifest(second.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T11:00:00.000Z";
    manifest.cwd = otherCwd;
  });

  const otherWorkspaceDir = join(dir, "runs", "other-repo", "oth123");
  mkdirSync(otherWorkspaceDir, { recursive: true });
  const otherManifest = readManifest(second.workspaceDir);
  otherManifest.runId = "oth123";
  otherManifest.repo = "other-repo";
  otherManifest.cwd = join(dir, "other-repo-cwd");
  otherManifest.workspaceDir = otherWorkspaceDir;
  otherManifest.assignmentPath = join(otherWorkspaceDir, "assignment-seed.md");
  otherManifest.startedAt = "2026-04-12T09:00:00.000Z";
  otherManifest.archivedAt = null;
  writeFileSync(join(otherWorkspaceDir, "run.json"), `${JSON.stringify(otherManifest, null, 2)}\n`);
  writeFileSync(otherManifest.assignmentPath, "# Assignment seed\n");

  mkdirSync(join(dir, "runs", "broken", "bad111"), { recursive: true });
  writeFileSync(join(dir, "runs", "broken", "bad111", "run.json"), "{ bad json\n");

  const defaultText = runCli(["list", "runs"], { cwd: dir });
  assert.equal(defaultText.trim(), "No runs found.");

  const includeArchived = runCli(["list", "runs", "--include-archived"], { cwd: dir });
  assert.match(
    includeArchived,
    new RegExp(
      `${first.runId} \\[initialized\\] name=<unnamed> 0/2 .* archived=2026-04-12T12:00:00.000Z cwd=${dir.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}`,
    ),
  );
  assert.doesNotMatch(includeArchived, new RegExp(second.runId));

  const explicitCwd = runCli(["list", "runs", "--cwd", otherCwd], { cwd: dir });
  assert.equal(
    explicitCwd.trim(),
    `${second.runId} [initialized] name=<unnamed> 0/2 repo=unknown agent=run-mgmt-agent assignment=run-mgmt-work cwd=${otherCwd}`,
  );
  assert.doesNotMatch(explicitCwd, /^oth123 /m);

  const repoScoped = runCli(["list", "runs", "--repo", "other-repo"], { cwd: dir });
  assert.equal(
    repoScoped.trim(),
    `oth123 [initialized] name=<unnamed> 0/2 repo=other-repo agent=run-mgmt-agent assignment=run-mgmt-work cwd=${otherManifest.cwd}`,
  );

  const globalText = runCli(["list", "runs", "--global"], { cwd: dir });
  assert.doesNotMatch(globalText, new RegExp(first.runId));
  assert.match(
    globalText,
    new RegExp(
      `^${second.runId} \\[initialized\\] name=<unnamed> 0/2 repo=unknown agent=run-mgmt-agent assignment=run-mgmt-work cwd=${otherCwd.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`,
      "m",
    ),
  );
  assert.match(
    globalText,
    new RegExp(
      `^oth123 \\[initialized\\] name=<unnamed> 0/2 repo=other-repo agent=run-mgmt-agent assignment=run-mgmt-work cwd=${otherManifest.cwd.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}$`,
      "m",
    ),
  );

  const jsonOut = runCli(
    ["list", "runs", "--global", "--include-archived", "--output-format", "json"],
    {
      cwd: dir,
    },
  );
  const parsed = JSON.parse(jsonOut);
  assert.deepEqual(
    parsed.map((run) => run.runId),
    [second.runId, first.runId, "oth123"],
  );
  assert.equal(parsed[1].archivedAt, "2026-04-12T12:00:00.000Z");
  assert.equal(parsed[0].status, "initialized");
  assert.equal(parsed[0].effectiveStatus, "initialized");
  assert.deepEqual(parsed[0].dependencyState, {
    ready: true,
    total: 0,
    satisfied: 0,
    unsatisfied: 0,
  });
  assert.deepEqual(parsed[0].capabilities, {
    canArchive: true,
    canUnarchive: false,
    canReset: true,
    canDelete: false,
    canReady: true,
    canAbort: false,
    abortReason: "not_active_in_daemon",
    canResume: false,
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
    },
  });
  assert.deepEqual(parsed[1].capabilities, {
    canArchive: false,
    canUnarchive: true,
    canReset: true,
    canDelete: true,
    canReady: false,
    canAbort: false,
    abortReason: "not_active_in_daemon",
    canResume: false,
    taskMutation: {
      canSetStatus: true,
      canEditNotes: true,
      canAdd: true,
    },
  });
  assert.deepEqual(parsed[1].dependencyState, {
    ready: true,
    total: 0,
    satisfied: 0,
    unsatisfied: 0,
  });
});

test("list runs rejects conflicting scope flags with exit code 3", () => {
  const dir = tempDir();
  const failure = runCliExpectFail(["list", "runs", "--cwd", dir, "--repo", "task-runner"], {
    cwd: dir,
  });
  assert.equal(failure.status, 3);
  assert.match(failure.stderr, /list runs accepts only one of --cwd, --repo, or --global/);
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

test("run ready promotes initialized runs and returns text and json results", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  const text = runCli(["run", "ready", outcome.runId], { cwd: dir });
  assert.match(text, new RegExp(`promoted run ${outcome.runId} to ready`));

  let manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "ready");

  const second = await initRun(dir);
  const json = runCli(["run", "ready", second.runId, "--output-format", "json"], { cwd: dir });
  assert.equal(JSON.parse(json).runId, second.runId);
  assert.equal(JSON.parse(json).status, "ready");

  manifest = readManifest(second.workspaceDir);
  assert.equal(manifest.status, "ready");
});

test("run schedule sets, toggles, clears, and run ready accepts schedule flags", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  const setText = runCli(["run", "schedule", outcome.runId, "--at", "2026-04-25T12:00:00.000Z"], {
    cwd: dir,
  });
  assert.match(setText, /set schedule/);
  assert.equal(readManifest(outcome.workspaceDir).schedule.runAt, "2026-04-25T12:00:00.000Z");

  const disableJson = JSON.parse(
    runCli(["run", "schedule", "disable", outcome.runId, "--output-format", "json"], {
      cwd: dir,
    }),
  );
  assert.equal(disableJson.schedule.enabled, false);

  const clearText = runCli(["run", "schedule", "clear", outcome.runId], { cwd: dir });
  assert.match(clearText, /cleared schedule/);
  assert.equal(readManifest(outcome.workspaceDir).schedule, null);

  const ready = await initRun(dir);
  const readyJson = JSON.parse(
    runCli(
      [
        "run",
        "ready",
        ready.runId,
        "--schedule-cron",
        "0 9 * * *",
        "--schedule-timezone",
        "UTC",
        "--schedule-mode",
        "clone",
        "--schedule-continue-on-failure",
        "--output-format",
        "json",
      ],
      { cwd: dir },
    ),
  );
  assert.equal(readyJson.status, "ready");
  assert.equal(readyJson.schedule.recurrence.schedule.expression, "0 9 * * *");
  assert.equal(readyJson.schedule.recurrence.mode, "clone");
  assert.equal(readyJson.schedule.recurrence.continueOnFailure, true);

  runCli(["run", "reset", ready.runId], { cwd: dir });
  const resetManifest = readManifest(ready.workspaceDir);
  assert.equal(resetManifest.status, "initialized");
  assert.equal(resetManifest.schedule.recurrence.schedule.expression, "0 9 * * *");
  assert.equal(resetManifest.schedule.recurrence.mode, "clone");
});

test("run schedule validates required target and schedule flag combinations", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);

  let result = runCliExpectFail(["run", "schedule"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run schedule requires <id-or-path>/);

  result = runCliExpectFail(["run", "schedule", outcome.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /requires exactly one of --at, --delay, or --cron/);

  result = runCliExpectFail(
    ["run", "schedule", outcome.runId, "--at", "2026-04-25T12:00:00.000Z", "--cron", "0 9 * * *"],
    {
      cwd: dir,
    },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /requires exactly one of --at, --delay, or --cron/);

  result = runCliExpectFail(
    ["run", "schedule", outcome.runId, "--delay", "30m", "--timezone", "UTC"],
    {
      cwd: dir,
    },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /--timezone is valid only with --cron/);
});

test("run set-name updates, clears, and preserves reset seed", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAgent(dir, "run-mgmt-passive-agent", PASSIVE_AGENT);
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
  writeAgent(dir, "run-mgmt-passive-agent", PASSIVE_AGENT);
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

test("run set-backend-session and clear-backend-session mutate passive metadata only", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAgent(dir, "run-mgmt-passive-agent", PASSIVE_AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const passiveRun = await initRun(dir, "run-mgmt-passive-agent");
  const nonPassiveRun = await initRun(dir);

  patchManifest(passiveRun.workspaceDir, (manifest) => {
    manifest.status = "blocked";
    manifest.archivedAt = "2026-04-17T12:00:00.000Z";
  });

  const setText = runCli(["run", "set-backend-session", passiveRun.runId, "thread-42"], {
    cwd: dir,
  });
  assert.match(setText, /set backend session for run .*"thread-42"/);
  let manifest = readManifest(passiveRun.workspaceDir);
  assert.equal(manifest.backendSessionId, "thread-42");
  assert.equal(manifest.status, "blocked");
  assert.equal(manifest.archivedAt, "2026-04-17T12:00:00.000Z");

  const setAgainJson = runCli(
    ["run", "set-backend-session", passiveRun.runId, " thread-42 ", "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(setAgainJson), {
    runId: passiveRun.runId,
    backendSessionId: "thread-42",
    changed: false,
  });

  const clearText = runCli(["run", "clear-backend-session", passiveRun.runId], { cwd: dir });
  assert.match(clearText, /cleared backend session for run/);
  manifest = readManifest(passiveRun.workspaceDir);
  assert.equal(manifest.backendSessionId, null);
  assert.equal(manifest.status, "blocked");

  const clearAgainJson = runCli(
    ["run", "clear-backend-session", passiveRun.runId, "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(clearAgainJson), {
    runId: passiveRun.runId,
    backendSessionId: null,
    changed: false,
  });

  let result = runCliExpectFail(["run", "set-backend-session"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run set-backend-session requires <id-or-path> <session-id>/);

  result = runCliExpectFail(["run", "set-backend-session", passiveRun.runId, "   "], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run set-backend-session: <session-id> cannot be empty/);

  result = runCliExpectFail(["run", "clear-backend-session"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run clear-backend-session requires <id-or-path>/);

  result = runCliExpectFail(["run", "set-backend-session", nonPassiveRun.runId, "thread-9"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /only allowed for passive runs/);
});

test("run add-dep, remove-dep, and clear-deps expose text/json results and persist manifest state", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const target = await initRun(dir);
  const dependency = await initRun(dir);

  const addedText = runCli(["run", "add-dep", target.runId, dependency.runId], { cwd: dir });
  assert.match(
    addedText,
    new RegExp(`added dependency ${dependency.runId} to run ${target.runId}`),
  );

  let manifest = readManifest(target.workspaceDir);
  assert.deepEqual(manifest.dependencyRunIds, [dependency.runId]);
  assert.deepEqual(manifest.resetSeed.dependencyRunIds, [dependency.runId]);

  const removedJson = runCli(
    ["run", "remove-dep", target.runId, dependency.runId, "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(removedJson), {
    runId: target.runId,
    dependencyRunIds: [],
    changed: true,
  });

  manifest = readManifest(target.workspaceDir);
  assert.deepEqual(manifest.dependencyRunIds, []);

  const clearedJson = runCli(["run", "clear-deps", target.runId, "--output-format", "json"], {
    cwd: dir,
  });
  assert.deepEqual(JSON.parse(clearedJson), {
    runId: target.runId,
    dependencyRunIds: [],
    changed: false,
  });

  const clearedText = runCli(["run", "clear-deps", target.runId], { cwd: dir });
  assert.match(clearedText, new RegExp(`run ${target.runId} already has no dependencies`));
});

test("run dependency commands validate args and graph failures", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const target = await initRun(dir);
  const dependency = await initRun(dir);
  const downstream = await initRun(dir);

  let result = runCliExpectFail(["run", "add-dep", target.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run add-dep requires <id-or-path> <dependency-run-id>/);

  result = runCliExpectFail(["run", "clear-deps"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run clear-deps requires <id-or-path>/);

  result = runCliExpectFail(["run", "add-dep", target.runId, dependency.runId, "--clear"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run add-dep only supports <id-or-path>, <dependency-run-id>/);

  result = runCliExpectFail(["run", "add-dep", target.runId, "missing-run"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /dependency run missing-run was not found/);

  result = runCliExpectFail(["run", "add-dep", target.runId, target.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, new RegExp(`run ${target.runId} cannot depend on itself`));

  runCli(["run", "add-dep", target.runId, dependency.runId], { cwd: dir });
  result = runCliExpectFail(["run", "add-dep", target.runId, dependency.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    new RegExp(`dependency ${dependency.runId} already exists on run ${target.runId}`),
  );

  runCli(["run", "add-dep", dependency.runId, downstream.runId], { cwd: dir });
  result = runCliExpectFail(["run", "add-dep", downstream.runId, target.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, new RegExp(`adding dependency ${target.runId} would create a cycle`));

  result = runCliExpectFail(["run", "remove-dep", target.runId, "missing-dep"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run remove-dep: dependency missing-dep does not exist/);
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

test("run --resume-run rejects initialized runs with unsatisfied dependencies", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const target = await initRun(dir);
  const dependency = await initRun(dir);

  runCli(["run", "add-dep", target.runId, dependency.runId], { cwd: dir });
  runCli(["run", "ready", target.runId], { cwd: dir });

  const result = runCliExpectFail(["run", "--resume-run", target.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    new RegExp(
      `cannot execute run ${target.runId} because 1 dependency run\\(s\\) are not successful`,
    ),
  );
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
