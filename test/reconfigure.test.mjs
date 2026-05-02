import { strict as assert } from "node:assert";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addRunAttachmentFromFile, reconfigureRun } from "../packages/core/dist/app/service.js";
import { codexBackend } from "../packages/core/dist/backends/codex.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { readyRun } from "../packages/core/dist/core/commands/service.js";
import { readRunAuditHistory } from "../packages/core/dist/core/run/run-events.js";
import { LockedFieldError, runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { sharedRuntimeEnv, withEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-reconfigure-"));
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

function writeLauncher(baseDir, name, body) {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}.yaml`), body);
}

function writeScript(baseDir, name, body) {
  const path = join(baseDir, name);
  writeFileSync(path, body);
  return path;
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function assertTimestampAdvanced(before, after, label) {
  assert.ok(after > before, `${label}: expected ${after} to be after ${before}`);
}

function writeManifest(workspaceDir, manifest) {
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
}

function mockBackend(id = "claude") {
  return {
    id,
    ...(id === "codex" ? { resolveConfig: codexBackend.resolveConfig } : {}),
    invoke: async () => {
      throw new Error("backend should not be invoked while reconfiguring initialized runs");
    },
  };
}

async function initRunIn(baseDir, opts = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(opts.agentName ?? "agent", baseDir);
    const loadedAssignment =
      opts.assignmentName === null
        ? undefined
        : loadAssignmentConfig(opts.assignmentName ?? "work", baseDir);
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars: opts.cliVars ?? {},
      webVars: {},
      backend: mockBackend(opts.backendId ?? loaded.config.backend),
      initialize: true,
      runGroupId: opts.runGroupId,
      callerCwd: baseDir,
      overrides: opts.overrides,
    });
  });
}

test("reconfigure: patches initialized vars and message, rerenders frozen surfaces, preserves codex transport, and audits keys only", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: codex
backendArgs:
  codex:
    extraArgs:
      - --frozen-codex-arg
      - value
---
Agent for {{target}} on {{branch}}.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
cwd: worktrees/{{branch}}
message: original message
callerInstructions: Caller sees {{target}} on {{branch}}.
vars:
  target:
    type: string
    required: true
  branch:
    type: string
    required: true
tasks:
  - id: t1
    title: Ship {{target}}
    body: Use {{branch}}.
---
Assignment for {{target}} on {{branch}}.
`,
  );

  const initialTransport = { transport: { type: "ws", url: "ws://initial.example/ws" } };
  const init = await withEnv({ TASK_RUNNER_CODEX_WS_URL: "ws://initial.example/ws" }, () =>
    initRunIn(dir, {
      backendId: "codex",
      cliVars: { target: "alpha", branch: "main" },
    }),
  );
  const initialManifest = readManifest(init.workspaceDir);
  const evidencePath = join(dir, "evidence.txt");
  writeFileSync(evidencePath, "keep this attachment\n");
  const attachment = await withSharedRuntimeEnv(dir, () =>
    addRunAttachmentFromFile(init.runId, {
      sourcePath: evidencePath,
      name: "evidence.txt",
    }),
  );

  const detail = await withEnv({ TASK_RUNNER_CODEX_WS_URL: "ws://changed.example/ws" }, () =>
    withSharedRuntimeEnv(dir, () =>
      reconfigureRun(init.runId, {
        vars: { branch: "release" },
        message: "replacement message\n",
      }),
    ),
  );
  const manifest = readManifest(init.workspaceDir);
  const history = readRunAuditHistory({ workspaceDir: init.workspaceDir, runId: init.runId });
  const reconfigured = history.events.at(-1);

  assert.equal(detail.runId, init.runId);
  assert.equal(manifest.status, "initialized");
  assertTimestampAdvanced(initialManifest.updatedAt, manifest.updatedAt, "reconfigure updatedAt");
  assert.equal(manifest.message, "replacement message\n");
  assert.equal(manifest.runtimeVars.target, "alpha");
  assert.equal(manifest.runtimeVars.branch, "release");
  assert.equal(manifest.cwd, initialManifest.cwd);
  assert.equal(manifest.resetSeed.cwd, initialManifest.cwd);
  assert.equal(manifest.finalTasks.t1.title, "Ship alpha");
  assert.equal(manifest.finalTasks.t1.body, "Use release.");
  assert.ok(manifest.brief.includes("Agent for alpha on release."));
  assert.equal(manifest.agent.instructions, "Agent for alpha on release.");
  assert.ok(manifest.brief.includes("Assignment for alpha on release."));
  assert.ok(manifest.brief.endsWith("replacement message"));
  assert.equal(manifest.callerInstructions, "Caller sees alpha on release.");
  assert.equal(manifest.resetSeed.message, "replacement message\n");
  assert.equal(manifest.resetSeed.finalTasks.t1.body, "Use release.");
  assert.equal(manifest.attachments.length, 1);
  assert.equal(manifest.attachments[0].id, attachment.id);
  assert.equal(manifest.resetSeed.attachments.length, 1);
  assert.equal(manifest.resetSeed.attachments[0].id, attachment.id);
  assert.equal(
    readFileSync(join(init.workspaceDir, manifest.attachments[0].relativePath), "utf8"),
    "keep this attachment\n",
  );
  assert.deepEqual(manifest.backendConfig, initialTransport);
  assert.deepEqual(manifest.resetSeed.backendConfig, initialTransport);
  assert.deepEqual(manifest.resolvedBackendArgs, ["--frozen-codex-arg", "value"]);
  assert.deepEqual(manifest.resetSeed.resolvedBackendArgs, ["--frozen-codex-arg", "value"]);
  assert.equal(reconfigured.event.type, "run.reconfigured");
  assert.deepEqual(reconfigured.event.fields, {
    changedVarKeys: ["branch"],
    messageChanged: true,
  });
});

test("reconfigure: re-interpolates and re-freezes launcher args from patched vars", async () => {
  const dir = tempDir();
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: wrap
args:
  - "{{flavor}}"
  - "{{run_group_id}}"
`,
  );
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
launcher:
  command: agent-wrap
  args:
    - agent-owned
---
Agent for {{flavor}}.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
cwd: worktrees/{{run_group_id}}/{{flavor}}
vars:
  flavor:
    type: string
    required: true
tasks:
  - id: t1
    title: Ship {{flavor}}
---
Assignment.
`,
  );

  const init = await initRunIn(dir, {
    cliVars: { flavor: "alpha" },
    overrides: { launcher: "shared" },
  });
  assert.deepEqual(init.manifest.launcher, {
    kind: "prefix",
    command: "wrap",
    args: ["alpha", init.runId],
    name: "shared",
    source: "named",
  });

  const detail = await withSharedRuntimeEnv(dir, () =>
    reconfigureRun(init.runId, {
      vars: { flavor: "beta" },
    }),
  );
  const manifest = readManifest(init.workspaceDir);

  const expectedLauncher = {
    kind: "prefix",
    command: "wrap",
    args: ["beta", init.runId],
    name: "shared",
    source: "named",
  };
  assert.equal(detail.runId, init.runId);
  assert.equal(manifest.cwd, init.manifest.cwd);
  assert.deepEqual(manifest.launcher, expectedLauncher);
  assert.deepEqual(manifest.resetSeed.launcher, expectedLauncher);
});

test("reconfigure: ignores leaked env run group when re-freezing launcher", async () => {
  const dir = tempDir();
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: wrap
args:
  - "{{flavor}}"
  - "{{run_group_id}}"
`,
  );
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
launcher: shared
---
Agent for {{flavor}}.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
cwd: worktrees/{{run_group_id}}/{{flavor}}
vars:
  flavor:
    type: string
    required: true
tasks:
  - id: t1
    title: Ship {{flavor}}
---
Assignment.
`,
  );

  const init = await initRunIn(dir, {
    cliVars: { flavor: "alpha" },
    runGroupId: "original-group",
  });

  const detail = await withSharedRuntimeEnv(dir, () =>
    withEnv({ TASK_RUNNER_RUN_GROUP_ID: "leaked-group" }, () =>
      reconfigureRun(init.runId, {
        vars: { flavor: "beta" },
      }),
    ),
  );
  const manifest = readManifest(init.workspaceDir);

  const expectedLauncher = {
    kind: "prefix",
    command: "wrap",
    args: ["beta", "original-group"],
    name: "shared",
    source: "named",
  };
  assert.equal(detail.runId, init.runId);
  assert.equal(manifest.runGroupId, "original-group");
  assert.equal(manifest.cwd, init.manifest.cwd);
  assert.ok(manifest.cwd.includes("original-group"));
  assert.ok(!manifest.cwd.includes("leaked-group"));
  assert.deepEqual(manifest.launcher, expectedLauncher);
  assert.deepEqual(manifest.resetSeed.launcher, expectedLauncher);
});

test("reconfigure: empty and unchanged-message patches are no-ops", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
---
Agent.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
message: keep me
vars:
  target:
    type: string
    required: true
tasks:
  - id: t1
    title: First {{target}}
---
Work {{target}}.
`,
  );
  const init = await initRunIn(dir, { cliVars: { target: "alpha" } });
  const before = readFileSync(join(init.workspaceDir, "run.json"), "utf8");
  const beforeHistory = readRunAuditHistory({ workspaceDir: init.workspaceDir, runId: init.runId });

  await withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, {}));
  await withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { message: "keep me" }));
  await withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { vars: { target: "alpha" } }));

  assert.equal(readFileSync(join(init.workspaceDir, "run.json"), "utf8"), before);
  assert.deepEqual(
    readRunAuditHistory({ workspaceDir: init.workspaceDir, runId: init.runId }),
    beforeHistory,
  );
});

test("reconfigure: no-assignment runs derive and remove assignment seed snapshots", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
---
Agent.
`,
  );
  const init = await initRunIn(dir, {
    assignmentName: null,
    overrides: { message: "initial message" },
  });

  assert.equal(readManifest(init.workspaceDir).assignment, null);
  assert.equal(existsSync(join(init.workspaceDir, "assignment-seed.md")), false);

  await withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { message: "updated message" }));

  const manifest = readManifest(init.workspaceDir);
  assert.equal(manifest.assignment, null);
  assert.equal(manifest.message, "updated message");
  assert.equal(manifest.resetSeed.message, "updated message");
  assert.equal(existsSync(join(init.workspaceDir, "assignment-seed.md")), false);
});

test("reconfigure: rejects archived and non-initialized runs", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
---
Agent.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  const init = await initRunIn(dir);

  await withSharedRuntimeEnv(dir, () => readyRun(init.runId));
  await assert.rejects(
    () => withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { message: "late" })),
    /cannot reconfigure run .* unless it is initialized/,
  );

  const manifest = readManifest(init.workspaceDir);
  manifest.status = "initialized";
  manifest.archivedAt = "2026-04-25T19:00:00.000Z";
  writeManifest(init.workspaceDir, manifest);
  await assert.rejects(
    () => withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { message: "archived" })),
    /cannot reconfigure archived run/,
  );
});

test("reconfigure: var validation failure preserves the previous manifest", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
---
Agent.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
vars:
  count:
    type: number
    required: true
tasks:
  - id: t1
    title: Count {{count}}
---
Work {{count}}.
`,
  );
  const init = await initRunIn(dir, { cliVars: { count: "1" } });
  const before = readFileSync(join(init.workspaceDir, "run.json"), "utf8");

  await assert.rejects(
    () => withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { vars: { count: "many" } })),
    /var "count": expected number, got "many"/,
  );
  assert.equal(readFileSync(join(init.workspaceDir, "run.json"), "utf8"), before);
});

test("reconfigure: required-var failure preserves the previous manifest", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
---
Agent.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  const init = await initRunIn(dir);
  const before = readFileSync(join(init.workspaceDir, "run.json"), "utf8");
  writeFileSync(
    join(init.workspaceDir, "assignment-seed.md"),
    `---
schemaVersion: 1
name: work
vars:
  missing:
    type: string
    required: true
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  await assert.rejects(
    () => withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { message: "new" })),
    /missing required initial var: missing/,
  );
  assert.equal(readFileSync(join(init.workspaceDir, "run.json"), "utf8"), before);
});

test("reconfigure: prepare render failure preserves the previous manifest", async () => {
  const dir = tempDir();
  const scriptPath = writeScript(
    dir,
    "prepare.mjs",
    'process.stdout.write(JSON.stringify({ action: "continue" }));\n',
  );
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
---
Agent.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
hooks:
  prepare:
    - builtin: command
      with:
        mode: json
        command: ${JSON.stringify(process.execPath)}
        args:
          - ${JSON.stringify(scriptPath)}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  const init = await initRunIn(dir);
  const before = readFileSync(join(init.workspaceDir, "run.json"), "utf8");
  writeFileSync(scriptPath, 'process.stdout.write("{bad");\n');

  await assert.rejects(
    () => withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { message: "new" })),
    /malformed JSON output/,
  );
  assert.equal(readFileSync(join(init.workspaceDir, "run.json"), "utf8"), before);
});

test("reconfigure: locked message and locked rendered task fields reject without mutation", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "agent",
    `---
schemaVersion: 1
name: agent
backend: claude
---
Agent.
`,
  );
  writeAssignment(
    dir,
    "work",
    `---
schemaVersion: 1
name: work
message: fixed
lockedFields: [message, tasks]
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
  const init = await initRunIn(dir);
  const before = readFileSync(join(init.workspaceDir, "run.json"), "utf8");

  await assert.rejects(
    () => withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { message: "new" })),
    (err) =>
      err instanceof LockedFieldError &&
      err.message.startsWith("cannot override locked field: message"),
  );
  assert.equal(readFileSync(join(init.workspaceDir, "run.json"), "utf8"), before);

  await assert.rejects(
    () => withSharedRuntimeEnv(dir, () => reconfigureRun(init.runId, { vars: { target: "beta" } })),
    /cannot reconfigure locked field: tasks/,
  );
  assert.equal(readFileSync(join(init.workspaceDir, "run.json"), "utf8"), before);
});
