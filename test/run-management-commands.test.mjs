import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { freePort, startCliDaemon as startCliDaemonProcess } from "./helpers/daemon-process.mjs";
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

function writeFakeClaude(baseDir) {
  const path = join(baseDir, "fake-claude.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
process.stdout.write(JSON.stringify({
  type: "result",
  session_id: "sess-cli-message-file",
  result: "ok"
}) + "\\n");
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function writeBlockingClaude(baseDir) {
  const path = join(baseDir, "blocking-claude.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
const finish = (code) => process.exit(code);
process.on("SIGTERM", () => finish(143));
process.on("SIGINT", () => finish(130));
setTimeout(() => finish(0), 60_000);
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function writeFakeClaudeSessionFile(baseDir, cwd, sessionId) {
  const encodedCwd = cwd.replace(/[/.]/g, "-");
  const path = join(baseDir, ".claude", "projects", encodedCwd, `${sessionId}.jsonl`);
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, "");
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
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()), ...(opts.env ?? {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliExpectFail(args, opts = {}) {
  try {
    execFileSync("node", [CLI_PATH, ...args], {
      cwd: opts.cwd ?? process.cwd(),
      env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()), ...(opts.env ?? {}) },
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

async function startCliDaemon(baseDir, listenUrl) {
  return await startCliDaemonProcess(baseDir, listenUrl, CLI_PATH);
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function assertTimestampAdvanced(before, after, label) {
  assert.ok(after > before, `${label}: expected ${after} to be after ${before}`);
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
    manifest.runGroupId = first.runId;
    manifest.resetSeed.runGroupId = first.runId;
  });
  patchManifest(second.workspaceDir, (manifest) => {
    manifest.startedAt = "2026-04-12T11:00:00.000Z";
    manifest.cwd = otherCwd;
    manifest.runGroupId = first.runId;
    manifest.resetSeed.runGroupId = first.runId;
  });

  const otherWorkspaceDir = join(dir, "runs", "other-repo", "oth123");
  mkdirSync(otherWorkspaceDir, { recursive: true });
  const otherManifest = readManifest(second.workspaceDir);
  otherManifest.runId = "oth123";
  otherManifest.repo = "other-repo";
  otherManifest.cwd = join(dir, "other-repo-cwd");
  otherManifest.workspaceDir = otherWorkspaceDir;
  otherManifest.runGroupId = otherManifest.runId;
  otherManifest.resetSeed.runGroupId = otherManifest.runId;
  otherManifest.startedAt = "2026-04-12T09:00:00.000Z";
  otherManifest.archivedAt = null;
  writeFileSync(join(otherWorkspaceDir, "run.json"), `${JSON.stringify(otherManifest, null, 2)}\n`);
  writeFileSync(join(otherWorkspaceDir, "assignment-seed.md"), "# Assignment seed\n");

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

  const groupScopedJson = runCli(
    ["list", "runs", "--group-id", first.runId, "--include-archived", "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(
    JSON.parse(groupScopedJson).map((run) => run.runId),
    [second.runId, first.runId],
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
    canReconfigure: true,
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
    canReconfigure: false,
    reconfigureReason: "archived",
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
  const failure = runCliExpectFail(["list", "runs", "--cwd", dir, "--group-id", "task-runner"], {
    cwd: dir,
  });
  assert.equal(failure.status, 3);
  assert.match(
    failure.stderr,
    /list runs accepts only one of --cwd, --repo, --global, or --group-id/,
  );
});

test("run archive and run unarchive expose idempotent text and json results", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);
  const previousUpdatedAt = readManifest(outcome.workspaceDir).updatedAt;

  const archivedText = runCli(["run", "archive", outcome.runId], { cwd: dir });
  assert.match(archivedText, new RegExp(`archived run ${outcome.runId}`));
  let manifest = readManifest(outcome.workspaceDir);
  assert.ok(manifest.archivedAt);
  assert.equal(manifest.updatedAt, previousUpdatedAt);

  const archivedAgainJson = runCli(["run", "archive", outcome.runId, "--output-format", "json"], {
    cwd: dir,
  });
  const archivedAgain = JSON.parse(archivedAgainJson);
  assert.equal(archivedAgain.changed, false);
  assert.ok(archivedAgain.archivedAt);
  assert.equal(readManifest(outcome.workspaceDir).updatedAt, previousUpdatedAt);

  const unarchivedText = runCli(["run", "unarchive", outcome.runId], { cwd: dir });
  assert.match(unarchivedText, new RegExp(`unarchived run ${outcome.runId}`));
  manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.archivedAt, null);
  assert.equal(manifest.updatedAt, previousUpdatedAt);

  const unarchivedAgainJson = runCli(
    ["run", "unarchive", outcome.runId, "--output-format", "json"],
    { cwd: dir },
  );
  const unarchivedAgain = JSON.parse(unarchivedAgainJson);
  assert.equal(unarchivedAgain.changed, false);
  assert.equal(unarchivedAgain.archivedAt, null);
  assert.equal(readManifest(outcome.workspaceDir).updatedAt, previousUpdatedAt);
});

test("run ready promotes initialized runs and returns text and json results", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);
  const before = readManifest(outcome.workspaceDir).updatedAt;

  const text = runCli(["run", "ready", outcome.runId], { cwd: dir });
  assert.match(text, new RegExp(`promoted run ${outcome.runId} to ready`));

  let manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.status, "ready");
  assertTimestampAdvanced(before, manifest.updatedAt, "run ready updatedAt");

  const second = await initRun(dir);
  const json = runCli(["run", "ready", second.runId, "--output-format", "json"], { cwd: dir });
  assert.equal(JSON.parse(json).runId, second.runId);
  assert.equal(JSON.parse(json).status, "ready");

  manifest = readManifest(second.workspaceDir);
  assert.equal(manifest.status, "ready");
});

test("run queued resume message commands expose text and json contracts", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);
  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
  });

  const queuedJson = JSON.parse(
    runCli(
      ["run", "queue-message", outcome.runId, "First line\nSecond line", "--output-format", "json"],
      { cwd: dir },
    ),
  );
  assert.equal(queuedJson.runId, outcome.runId);
  assert.equal(queuedJson.queuedResumeMessage.text, "First line\nSecond line");
  assert.equal(queuedJson.queuedResumeMessageCount, 1);

  const listedText = runCli(["run", "queued-messages", outcome.runId], { cwd: dir });
  assert.equal(
    listedText,
    `Queued resume messages for run ${outcome.runId}:\n${queuedJson.queuedResumeMessage.id}  ${queuedJson.queuedResumeMessage.createdAt}\n  First line\n  Second line\n`,
  );

  const listedJson = JSON.parse(
    runCli(["run", "queued-messages", outcome.workspaceDir, "--output-format", "json"], {
      cwd: dir,
    }),
  );
  assert.deepEqual(listedJson, {
    runId: outcome.runId,
    queuedResumeMessages: [queuedJson.queuedResumeMessage],
  });

  const removedText = runCli(
    ["run", "remove-queued-message", outcome.runId, queuedJson.queuedResumeMessage.id],
    { cwd: dir },
  );
  assert.equal(
    removedText,
    `task-runner: removed queued message ${queuedJson.queuedResumeMessage.id} from run ${outcome.runId}\n`,
  );

  const emptyText = runCli(["run", "queued-messages", outcome.runId], { cwd: dir });
  assert.equal(emptyText, `No queued resume messages for run ${outcome.runId}.\n`);
});

test("run queued resume message commands support connected daemon mutations", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const command = writeBlockingClaude(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const started = JSON.parse(
      runCli(
        [
          "run",
          "--agent",
          "run-mgmt-agent",
          "--assignment",
          "run-mgmt-work",
          "--connect",
          listenUrl,
          "--detach",
          "--output-format",
          "json",
        ],
        { cwd: dir, env: { TASK_RUNNER_CLAUDE_BIN: command } },
      ),
    );
    const runId = started.runId;
    const queuedText = runCli(
      ["run", "queue-message", runId, "Remote queued message", "--connect", listenUrl],
      { cwd: dir },
    );
    const queuedId = queuedText.match(/queued message (qmsg[^ ]+) for run/)?.[1];
    assert.ok(queuedId, queuedText);

    const listedJson = JSON.parse(
      runCli(["run", "queued-messages", runId, "--connect", listenUrl, "--output-format", "json"], {
        cwd: dir,
      }),
    );
    assert.deepEqual(
      listedJson.queuedResumeMessages.map((message) => message.text),
      ["Remote queued message"],
    );

    const removedJson = JSON.parse(
      runCli(
        [
          "run",
          "remove-queued-message",
          runId,
          queuedId,
          "--connect",
          listenUrl,
          "--output-format",
          "json",
        ],
        { cwd: dir },
      ),
    );
    assert.deepEqual(removedJson, {
      runId,
      removedMessageId: queuedId,
      queuedResumeMessageCount: 0,
    });
  } finally {
    await daemon.stop("SIGTERM");
  }
});

test("run queue-message rejects malformed usage with exit code 3", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);
  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.status = "running";
  });

  let failure = runCliExpectFail(["run", "queue-message", outcome.runId], { cwd: dir });
  assert.equal(failure.status, 3);
  assert.match(failure.stderr, /run queue-message requires message text/);

  failure = runCliExpectFail(
    ["run", "queue-message", outcome.runId, "--message-file", "message.md"],
    { cwd: dir },
  );
  assert.equal(failure.status, 3);
  assert.match(failure.stderr, /run queue-message only supports/);
  assert.match(failure.stderr, /--message-file/);
});

test("init --message-file stores UTF-8 file content as the run message", () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const messagePath = join(dir, "message.md");
  writeFileSync(messagePath, "file message\nwith newline\n");

  const json = runCli(
    [
      "init",
      "--agent",
      "run-mgmt-agent",
      "--assignment",
      "run-mgmt-work",
      "--message-file",
      messagePath,
      "--output-format",
      "json",
    ],
    { cwd: dir },
  );
  const detail = JSON.parse(json);

  assert.equal(detail.message, "file message\nwith newline\n");
  assert.equal(readManifest(detail.workspaceDir).message, "file message\nwith newline\n");
});

test("run and run --resume-run accept --message-file as the backend message", () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(
    dir,
    "empty-work",
    `---
schemaVersion: 1
name: empty-work
---
Work.
`,
  );
  const fakeClaude = writeFakeClaude(dir);
  const firstMessage = join(dir, "first.md");
  const secondMessage = join(dir, "second.md");
  writeFileSync(firstMessage, "fresh file message\n");
  writeFileSync(secondMessage, "resume file message\n");

  const first = JSON.parse(
    runCli(
      [
        "run",
        "--agent",
        "run-mgmt-agent",
        "--assignment",
        "empty-work",
        "--message-file",
        firstMessage,
        "--output-format",
        "json",
      ],
      { cwd: dir, env: { HOME: dir, TASK_RUNNER_CLAUDE_BIN: fakeClaude } },
    ),
  );
  assert.equal(first.message, "fresh file message\n");
  assert.equal(first.status, "success");
  writeFakeClaudeSessionFile(dir, dir, "sess-cli-message-file");

  const second = JSON.parse(
    runCli(
      [
        "run",
        "--resume-run",
        first.runId,
        "--message-file",
        secondMessage,
        "--output-format",
        "json",
      ],
      { cwd: dir, env: { HOME: dir, TASK_RUNNER_CLAUDE_BIN: fakeClaude } },
    ),
  );
  assert.equal(second.sessions.at(-1).message, "resume file message\n");
  assert.equal(second.status, "success");
});

test("run reconfigure accepts --message-file and rejects message-file conflicts before mutation", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);
  const messagePath = join(dir, "new-message.md");
  writeFileSync(messagePath, "replacement from file\n");
  const beforeReconfigure = readManifest(outcome.workspaceDir).updatedAt;

  const text = runCli(["run", "reconfigure", outcome.runId, "--message-file", messagePath], {
    cwd: dir,
  });
  assert.equal(text, `task-runner: reconfigured run ${outcome.runId}\n`);
  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.message, "replacement from file\n");
  assertTimestampAdvanced(beforeReconfigure, manifest.updatedAt, "run reconfigure updatedAt");

  const before = readFileSync(join(outcome.workspaceDir, "run.json"), "utf8");
  const conflict = runCliExpectFail(
    ["run", "reconfigure", outcome.runId, "--message-file", messagePath, "positional"],
    { cwd: dir },
  );
  assert.equal(conflict.status, 3);
  assert.match(
    conflict.stderr,
    /task-runner: --message-file cannot be combined with a positional message/,
  );
  assert.equal(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"), before);
});

test("run reconfigure embedded maps lifecycle and var validation errors to exit 3", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(
    dir,
    "run-mgmt-work",
    `---
schemaVersion: 1
name: run-mgmt-work
vars:
  target:
    type: string
    default: alpha
tasks:
  - id: t1
    title: Ship {{target}}
---
Work.
`,
  );
  const outcome = await initRun(dir);
  const unknownVar = runCliExpectFail(["run", "reconfigure", outcome.runId, "--var", "missing=x"], {
    cwd: dir,
  });
  assert.equal(unknownVar.status, 3);
  assert.match(unknownVar.stderr, /unknown --var key\(s\): missing/);

  patchManifest(outcome.workspaceDir, (manifest) => {
    manifest.archivedAt = "2026-04-25T19:00:00.000Z";
  });
  const archived = runCliExpectFail(["run", "reconfigure", outcome.runId, "new message"], {
    cwd: dir,
  });
  assert.equal(archived.status, 3);
  assert.match(archived.stderr, /cannot reconfigure archived run/);
});

test("init --message-file reports unreadable files before creating a run", () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const missing = join(dir, "missing.md");

  const failure = runCliExpectFail(
    [
      "init",
      "--agent",
      "run-mgmt-agent",
      "--assignment",
      "run-mgmt-work",
      "--message-file",
      missing,
    ],
    { cwd: dir },
  );
  assert.equal(failure.status, 3);
  assert.match(failure.stderr, /task-runner: cannot read --message-file .*missing\.md:/);
});

test("run schedule sets, toggles, clears, and run ready accepts schedule flags", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const outcome = await initRun(dir);
  let previousUpdatedAt = readManifest(outcome.workspaceDir).updatedAt;

  const setText = runCli(["run", "schedule", outcome.runId, "--at", "2099-04-25T12:00:00.000Z"], {
    cwd: dir,
  });
  assert.match(setText, /set schedule/);
  let manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.schedule.runAt, "2099-04-25T12:00:00.000Z");
  assertTimestampAdvanced(previousUpdatedAt, manifest.updatedAt, "run schedule set updatedAt");
  previousUpdatedAt = manifest.updatedAt;

  const disableJson = JSON.parse(
    runCli(["run", "schedule", "disable", outcome.runId, "--output-format", "json"], {
      cwd: dir,
    }),
  );
  assert.equal(disableJson.schedule.enabled, false);
  manifest = readManifest(outcome.workspaceDir);
  assertTimestampAdvanced(previousUpdatedAt, manifest.updatedAt, "run schedule disable updatedAt");
  previousUpdatedAt = manifest.updatedAt;

  const clearText = runCli(["run", "schedule", "clear", outcome.runId], { cwd: dir });
  assert.match(clearText, /cleared schedule/);
  manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.schedule, null);
  assertTimestampAdvanced(previousUpdatedAt, manifest.updatedAt, "run schedule clear updatedAt");

  const recurring = await initRun(dir);
  runCli(
    [
      "run",
      "schedule",
      recurring.runId,
      "--cron",
      "0 * * * *",
      "--timezone",
      "UTC",
      "--mode",
      "reuse",
    ],
    { cwd: dir },
  );
  patchManifest(recurring.workspaceDir, (manifest) => {
    manifest.schedule = {
      ...manifest.schedule,
      enabled: false,
      runAt: "2026-04-25T13:23:00.000Z",
    };
  });
  const enabledRecurring = JSON.parse(
    runCli(["run", "schedule", "enable", recurring.runId, "--output-format", "json"], {
      cwd: dir,
    }),
  );
  assert.equal(enabledRecurring.schedule.enabled, true);
  assert.equal(enabledRecurring.schedule.recurrence.mode, "reuse");
  assert.notEqual(enabledRecurring.schedule.runAt, "2026-04-25T13:23:00.000Z");

  const ready = await initRun(dir);
  const readyBefore = readManifest(ready.workspaceDir).updatedAt;
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
  let readyManifest = readManifest(ready.workspaceDir);
  assertTimestampAdvanced(readyBefore, readyManifest.updatedAt, "run ready schedule updatedAt");

  const recurringClearText = runCli(["run", "schedule", "clear", ready.runId], { cwd: dir });
  assert.match(recurringClearText, /cleared schedule/);
  const beforeReadyClear = readyManifest.updatedAt;
  readyManifest = readManifest(ready.workspaceDir);
  assert.equal(readyManifest.schedule, null);
  assertTimestampAdvanced(
    beforeReadyClear,
    readyManifest.updatedAt,
    "run schedule clear ready updatedAt",
  );

  const beforeReset = readyManifest.updatedAt;
  runCli(["run", "reset", ready.runId], { cwd: dir });
  const resetManifest = readManifest(ready.workspaceDir);
  assert.equal(resetManifest.status, "initialized");
  assert.equal(resetManifest.schedule, null);
  assertTimestampAdvanced(beforeReset, resetManifest.updatedAt, "run reset updatedAt");
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
  let previousUpdatedAt = readManifest(outcome.workspaceDir).updatedAt;

  const setText = runCli(["run", "set-name", outcome.runId, "Run naming redesign"], { cwd: dir });
  assert.match(setText, /set name for run .*"Run naming redesign"/);

  let manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.name, "Run naming redesign");
  assert.equal(manifest.resetSeed.name, "Run naming redesign");
  assertTimestampAdvanced(previousUpdatedAt, manifest.updatedAt, "run set-name updatedAt");
  previousUpdatedAt = manifest.updatedAt;

  const setAgainJson = runCli(
    ["run", "set-name", outcome.runId, "Run naming redesign", "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(setAgainJson), {
    runId: outcome.runId,
    name: "Run naming redesign",
    updatedAt: previousUpdatedAt,
    changed: false,
  });
  assert.equal(readManifest(outcome.workspaceDir).updatedAt, previousUpdatedAt);

  const clearText = runCli(["run", "set-name", outcome.runId, "--clear"], { cwd: dir });
  assert.match(clearText, /cleared name for run/);

  manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.name, null);
  assert.equal(manifest.resetSeed.name, null);
  assertTimestampAdvanced(previousUpdatedAt, manifest.updatedAt, "run clear name updatedAt");
  previousUpdatedAt = manifest.updatedAt;

  const clearAgainJson = runCli(
    ["run", "set-name", outcome.runId, "--clear", "--output-format", "json"],
    { cwd: dir },
  );
  assert.deepEqual(JSON.parse(clearAgainJson), {
    runId: outcome.runId,
    name: null,
    updatedAt: previousUpdatedAt,
    changed: false,
  });
  assert.equal(readManifest(outcome.workspaceDir).updatedAt, previousUpdatedAt);
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
    updatedAt: manifest.updatedAt,
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
    updatedAt: manifest.updatedAt,
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

  const addedText = runCli(["run", "add-dep", target.runId, "--run", dependency.runId], {
    cwd: dir,
  });
  assert.match(
    addedText,
    new RegExp(`added run dependency ${dependency.runId} to run ${target.runId}`),
  );

  let manifest = readManifest(target.workspaceDir);
  assert.deepEqual(manifest.dependencies, [{ type: "run", runId: dependency.runId }]);
  assert.deepEqual(manifest.resetSeed.dependencies, [{ type: "run", runId: dependency.runId }]);

  const removedJson = runCli(
    ["run", "remove-dep", target.runId, "--run", dependency.runId, "--output-format", "json"],
    { cwd: dir },
  );
  const removedResult = JSON.parse(removedJson);
  assert.deepEqual(removedResult, {
    runId: target.runId,
    dependencies: [],
    updatedAt: removedResult.updatedAt,
    changed: true,
  });

  manifest = readManifest(target.workspaceDir);
  assert.equal(removedResult.updatedAt, manifest.updatedAt);
  assert.deepEqual(manifest.dependencies, []);

  const clearedJson = runCli(["run", "clear-deps", target.runId, "--output-format", "json"], {
    cwd: dir,
  });
  assert.deepEqual(JSON.parse(clearedJson), {
    runId: target.runId,
    dependencies: [],
    updatedAt: manifest.updatedAt,
    changed: false,
  });

  const clearedText = runCli(["run", "clear-deps", target.runId], { cwd: dir });
  assert.match(clearedText, new RegExp(`run ${target.runId} already has no dependencies`));
});

test("run set-group and clear-group expose text/json results and persist reset seed state", async () => {
  const dir = tempDir();
  writeAgent(dir, "run-mgmt-agent", AGENT);
  writeAssignment(dir, "run-mgmt-work", ASSIGNMENT);
  const target = await initRun(dir);

  const groupedText = runCli(["run", "set-group", target.runId, "shared-group"], { cwd: dir });
  assert.match(groupedText, new RegExp(`set group for run ${target.runId} to shared-group`));

  let manifest = readManifest(target.workspaceDir);
  assert.equal(manifest.runGroupId, "shared-group");
  assert.equal(manifest.resetSeed.runGroupId, "shared-group");

  const clearedJson = runCli(["run", "clear-group", target.runId, "--output-format", "json"], {
    cwd: dir,
  });
  const clearedResult = JSON.parse(clearedJson);
  assert.deepEqual(clearedResult, {
    runId: target.runId,
    runGroupId: target.runId,
    previousRunGroupId: "shared-group",
    updatedAt: clearedResult.updatedAt,
    changed: true,
  });

  manifest = readManifest(target.workspaceDir);
  assert.equal(clearedResult.updatedAt, manifest.updatedAt);
  assert.equal(manifest.runGroupId, target.runId);
  assert.equal(manifest.resetSeed.runGroupId, target.runId);
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
  assert.match(result.stderr, /run add-dep requires exactly one of --run or --group/);

  result = runCliExpectFail(["run", "clear-deps"], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run clear-deps requires <id-or-path>/);

  result = runCliExpectFail(["run", "add-dep", target.runId, dependency.runId, "--clear"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /run add-dep takes exactly one positional/);

  result = runCliExpectFail(["run", "add-dep", target.runId, "--run", "missing-run"], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, /dependency run missing-run was not found/);

  result = runCliExpectFail(["run", "add-dep", target.runId, "--run", target.runId], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(result.stderr, new RegExp(`run ${target.runId} cannot depend on itself`));

  runCli(["run", "add-dep", target.runId, "--run", dependency.runId], { cwd: dir });
  result = runCliExpectFail(["run", "add-dep", target.runId, "--run", dependency.runId], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    new RegExp(`dependency ${dependency.runId} already exists on run ${target.runId}`),
  );

  runCli(["run", "add-dep", dependency.runId, "--run", downstream.runId], { cwd: dir });
  result = runCliExpectFail(["run", "add-dep", downstream.runId, "--run", target.runId], {
    cwd: dir,
  });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    new RegExp(`adding dependency ${target.runId} would create a dependency cycle`),
  );

  result = runCliExpectFail(["run", "remove-dep", target.runId, "--run", "missing-dep"], {
    cwd: dir,
  });
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

  runCli(["run", "add-dep", target.runId, "--run", dependency.runId], { cwd: dir });
  runCli(["run", "ready", target.runId], { cwd: dir });

  const result = runCliExpectFail(["run", "--resume-run", target.runId], { cwd: dir });
  assert.equal(result.status, 3);
  assert.match(
    result.stderr,
    new RegExp(
      `cannot execute run ${target.runId} because 1 dependency ref\\(s\\) are not successful`,
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
