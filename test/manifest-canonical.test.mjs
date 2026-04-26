import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { passiveBackend } from "../packages/core/dist/backends/passive.js";
import {
  AgentConfigError,
  loadAgentConfig,
  loadAssignmentConfig,
} from "../packages/core/dist/config/loader.js";
import {
  loadedAgentFromManifest,
  synthesizeAdHocAgent,
} from "../packages/core/dist/core/config/loaded.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { sharedRuntimeEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

const CLAUDE_AGENT = `---
schemaVersion: 1
name: canonical-claude
backend: claude
model: claude-sonnet-4-6
effort: low
timeoutSec: 1800
lockedFields:
  - model
---
Your role: walk the checklist for {{cwd}}.
`;

const CODEX_AGENT = `---
schemaVersion: 1
name: canonical-codex
backend: codex
---
Your role: walk the checklist for {{cwd}}.
`;

const CODEX_UDS_AGENT = `---
schemaVersion: 1
name: canonical-codex-uds
backend: codex
backendSpecific:
  codex:
    transport:
      type: uds
      path: /tmp/codex.sock
---
Your role: walk the checklist for {{cwd}}.
`;

const CODEX_WS_AGENT = `---
schemaVersion: 1
name: canonical-codex-ws
backend: codex
backendSpecific:
  codex:
    transport:
      type: ws
      url: ws://127.0.0.1:4773
---
Your role: walk the checklist for {{cwd}}.
`;

const BASIC_ASSIGNMENT = `---
schemaVersion: 1
name: canonical-work
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
---
Work.
`;

const RESERVED_NAME_AGENT = `---
schemaVersion: 1
name: ad-hoc
backend: claude
---
Should not load.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-canonical-"));
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

function mockBackend(handler) {
  return { id: "claude", invoke: handler };
}

function okBackend() {
  return mockBackend(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    aborted: false,
    sessionId: "sess-canon-1",
    transcript: "done",
    rawStdout: "",
    rawStderr: "",
  }));
}

async function freshRun(baseDir, opts = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(opts.agentName ?? "canonical-claude", baseDir);
    const loadedAssignment = loadAssignmentConfig(opts.assignmentName ?? "canonical-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: opts.vars ?? {},
        backend: opts.backend ?? okBackend(),
        initialize: opts.initialize ?? false,
        overrides: opts.overrides,
        callerCwd: opts.callerCwd ?? baseDir,
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
    encoding: "utf8",
    env: {
      ...process.env,
      ...sharedRuntimeEnv(opts.cwd ?? process.cwd()),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

test("manifest schemaVersion is 14 and captures repo", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-claude", CLAUDE_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, { initialize: true });
  assert.equal(outcome.manifest.schemaVersion, 14);
  assert.equal(outcome.manifest.repo, "unknown");
  assert.equal(outcome.manifest.archivedAt, null);
  assert.equal(outcome.manifest.schedule, null);
});

test("resolveResumeTarget treats missing archivedAt on current manifests as unarchived", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-claude", CLAUDE_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, { initialize: true });

  const manifestPath = join(outcome.workspaceDir, "run.json");
  const manifest = readManifest(outcome.workspaceDir);
  manifest.archivedAt = undefined;
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

  const resolved = withSharedRuntimeEnv(dir, () => resolveResumeTarget(outcome.runId, dir));
  assert.equal(resolved.manifest.archivedAt, null);
});

test("first write freezes agent.instructions, lockedFields, and timeoutSec", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-claude", CLAUDE_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, { initialize: true });

  assert.ok(outcome.manifest.agent.instructions, "instructions populated");
  assert.match(outcome.manifest.agent.instructions, new RegExp(`walk the checklist for ${dir}`));
  assert.equal(outcome.manifest.timeoutSec, 1800, "agent timeoutSec frozen");
  assert.deepEqual(outcome.manifest.lockedFields, ["model"]);
  assert.equal(
    outcome.manifest.agent.sourcePath,
    join(dir, "agents", "canonical-claude", "agent.md"),
  );
});

test("ad-hoc agent: init without --agent synthesizes name='ad-hoc', null sourcePath, empty instructions", async () => {
  const dir = tempDir();
  // No agent file — only the assignment exists.
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);

  runCli(["init", "--backend", "passive", "--assignment", "canonical-work"], { cwd: dir });
  const runIds = readdirSync(join(dir, "runs", "unknown"));
  assert.equal(runIds.length, 1, "one run created");
  const runId = runIds[0];

  const manifest = readManifest(join(dir, "runs", "unknown", runId));
  assert.equal(manifest.agent.name, "ad-hoc");
  assert.equal(manifest.agent.sourcePath, null);
  assert.equal(manifest.agent.instructions, "");
  assert.equal(manifest.backend, "passive");
  assert.deepEqual(manifest.lockedFields, []);
  assert.equal(manifest.timeoutSec, 3600);
});

test("ad-hoc agent: --agent omitted without --backend errors with exit 3", async () => {
  const dir = tempDir();
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);

  try {
    execFileSync("node", [CLI_PATH, "init", "--assignment", "canonical-work"], {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        ...sharedRuntimeEnv(dir),
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    throw new Error("expected CLI to fail");
  } catch (err) {
    assert.equal(err.status, 3);
  }
});

test("ad-hoc agent: CLI overrides flow into the synthesized config", async () => {
  const loaded = synthesizeAdHocAgent({
    backend: "codex",
    model: "gpt-5.4",
    effort: "high",
    timeoutSec: 900,
    unrestricted: true,
  });
  assert.equal(loaded.config.name, "ad-hoc");
  assert.equal(loaded.sourcePath, null);
  assert.equal(loaded.instructions, "");
  assert.equal(loaded.config.backend, "codex");
  assert.equal(loaded.config.model, "gpt-5.4");
  assert.equal(loaded.config.effort, "high");
  assert.equal(loaded.config.timeoutSec, 900);
  assert.equal(loaded.config.unrestricted, true);
  assert.deepEqual(loaded.config.lockedFields, []);
});

test("ad-hoc collision guard: agent.md named 'ad-hoc' fails to load", async () => {
  const dir = tempDir();
  writeAgent(dir, "ad-hoc", RESERVED_NAME_AGENT);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => loadAgentConfig("ad-hoc", dir),
      (err) => {
        assert.ok(err instanceof AgentConfigError);
        assert.match(err.message, /"ad-hoc" is reserved/);
        return true;
      },
    );
  });
});

test("loadedAgentFromManifest reconstructs LoadedAgent from frozen fields", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-claude", CLAUDE_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, { initialize: true });

  const loaded = loadedAgentFromManifest(outcome.manifest);
  assert.equal(loaded.config.name, "canonical-claude");
  assert.equal(loaded.config.backend, "claude");
  assert.equal(loaded.config.model, "claude-sonnet-4-6");
  assert.equal(loaded.config.effort, "low");
  assert.equal(loaded.config.timeoutSec, 1800);
  assert.deepEqual(loaded.config.lockedFields, ["model"]);
  assert.match(loaded.instructions, /walk the checklist/);
  assert.equal(loaded.sourcePath, join(dir, "agents", "canonical-claude", "agent.md"));
});

test("loadedAgentFromManifest reconstructs frozen backendSpecific stdio transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-codex", CODEX_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, {
    agentName: "canonical-codex",
    backend: {
      id: "codex",
      async invoke(ctx) {
        assert.deepEqual(ctx.backendSpecific, {
          codex: {
            transport: {
              type: "stdio",
            },
          },
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      },
    },
  });

  const loaded = loadedAgentFromManifest(outcome.manifest);
  assert.deepEqual(loaded.config.backendSpecific, {
    codex: {
      transport: {
        type: "stdio",
      },
    },
  });
});

test("loadedAgentFromManifest reconstructs frozen backendSpecific UDS transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-codex-uds", CODEX_UDS_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, {
    agentName: "canonical-codex-uds",
    backend: {
      id: "codex",
      async invoke(ctx) {
        assert.deepEqual(ctx.backendSpecific, {
          codex: {
            transport: {
              type: "uds",
              path: "/tmp/codex.sock",
            },
          },
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      },
    },
  });

  const loaded = loadedAgentFromManifest(outcome.manifest);
  assert.deepEqual(loaded.config.backendSpecific, {
    codex: {
      transport: {
        type: "uds",
        path: "/tmp/codex.sock",
      },
    },
  });
});

test("loadedAgentFromManifest reconstructs frozen backendSpecific websocket transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-codex-ws", CODEX_WS_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, {
    agentName: "canonical-codex-ws",
    backend: {
      id: "codex",
      async invoke(ctx) {
        assert.deepEqual(ctx.backendSpecific, {
          codex: {
            transport: {
              type: "ws",
              url: "ws://127.0.0.1:4773",
            },
          },
        });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: null,
          transcript: "done",
          rawStdout: "",
          rawStderr: "",
        };
      },
    },
  });

  const loaded = loadedAgentFromManifest(outcome.manifest);
  assert.deepEqual(loaded.config.backendSpecific, {
    codex: {
      transport: {
        type: "ws",
        url: "ws://127.0.0.1:4773",
      },
    },
  });
});

test("resume does not re-read the agent source file", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-claude", CLAUDE_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);
  const outcome = await freshRun(dir, { initialize: true });

  // Now mutate the agent file after init — add a whole new locked
  // field and change the model. A naive resume-re-reads-file design
  // would pick these up; manifest-canonical must ignore them.
  const mutatedAgent = CLAUDE_AGENT.replace("claude-sonnet-4-6", "claude-opus-4-6").replace(
    "lockedFields:\n  - model",
    "lockedFields:\n  - model\n  - effort",
  );
  writeFileSync(join(dir, "agents", "canonical-claude", "agent.md"), mutatedAgent);

  // Resume (execute-after-init). Reload the manifest to get the
  // frozen values; loadedAgentFromManifest should produce a
  // LoadedAgent that reflects the ORIGINAL state, not the mutated file.
  const target = await withSharedRuntimeEnv(dir, async () =>
    resolveResumeTarget(outcome.runId, dir),
  );
  const loaded = loadedAgentFromManifest(target.manifest);

  assert.equal(loaded.config.model, "claude-sonnet-4-6", "model frozen to original");
  assert.deepEqual(
    loaded.config.lockedFields,
    ["model"],
    "lockedFields frozen (no 'effort' lock added)",
  );
});

test("passive backend: passiveBackend.invoke rejects cleanly", async () => {
  // (Existing smoke — re-asserted here because this file lives
  // next to the other passive-canonical checks.)
  await assert.rejects(async () => {
    await passiveBackend.invoke({
      prompt: "x",
      cwd: "/tmp",
      env: {},
      timeoutSec: 10,
    });
  }, /passive backend cannot be invoked/i);
});

test("schemaVersion mismatch: resume rejects a v1 manifest with a clear error", async () => {
  const dir = tempDir();
  const workspaceDir = join(dir, "runs", "unknown", "stale01");
  mkdirSync(workspaceDir, { recursive: true });
  // Write a minimal v1-shaped manifest missing the new required
  // fields. resolveResumeTarget should surface a version error,
  // not the generic "does not look like run.json" fallback.
  const v1Manifest = {
    schemaVersion: 1,
    runId: "stale01",
    agent: { name: "old", sourcePath: "/tmp/agent.md" },
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    message: null,
    name: null,
    unrestricted: false,
    cwd: dir,
    assignmentPath: join(workspaceDir, "assignment.md"),
    workspaceDir,
    startedAt: "2024-01-01T00:00:00Z",
    endedAt: null,
    status: "success",
    exitCode: 0,
    totalAttemptCount: 1,
    maxAttemptsPerSession: 4,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: "sess-old",
    runtimeVars: {},
    brief: null,
    finalTasks: {},
    totalSessionCount: 1,
    sessions: [],
    attemptRecords: [],
  };
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(v1Manifest, null, 2)}\n`);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => resolveResumeTarget("stale01", dir),
      (err) => {
        assert.match(err.message, /schemaVersion 1/);
        assert.match(err.message, /requires schemaVersion 14/);
        return true;
      },
    );
  });
});

test("schemaVersion mismatch: resume rejects a v2 manifest with a clear error", async () => {
  const dir = tempDir();
  const workspaceDir = join(dir, "runs", "unknown", "stale02");
  mkdirSync(workspaceDir, { recursive: true });
  const v2Manifest = {
    schemaVersion: 2,
    runId: "stale02",
    agent: { name: "old", sourcePath: "/tmp/agent.md", instructions: "" },
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    message: null,
    name: null,
    unrestricted: false,
    cwd: dir,
    lockedFields: [],
    timeoutSec: 3600,
    assignmentPath: join(workspaceDir, "assignment.md"),
    workspaceDir,
    startedAt: "2024-01-01T00:00:00Z",
    endedAt: null,
    status: "success",
    exitCode: 0,
    totalAttemptCount: 1,
    maxAttemptsPerSession: 4,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: "sess-old",
    runtimeVars: {},
    brief: null,
    callerInstructions: null,
    finalTasks: {},
    totalSessionCount: 1,
    sessions: [],
    attemptRecords: [],
  };
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(v2Manifest, null, 2)}\n`);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => resolveResumeTarget("stale02", dir),
      (err) => {
        assert.match(err.message, /schemaVersion 2/);
        assert.match(err.message, /requires schemaVersion 14/);
        return true;
      },
    );
  });
});

test("schemaVersion mismatch: resume rejects a v7 manifest with a clear error", async () => {
  const dir = tempDir();
  const workspaceDir = join(dir, "runs", "unknown", "stale07");
  mkdirSync(workspaceDir, { recursive: true });
  const v7Manifest = {
    schemaVersion: 7,
    runId: "stale07",
    agent: { name: "old", sourcePath: "/tmp/agent.md", instructions: "" },
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    message: null,
    name: null,
    unrestricted: false,
    cwd: dir,
    lockedFields: [],
    timeoutSec: 3600,
    assignmentPath: join(workspaceDir, "assignment.md"),
    workspaceDir,
    startedAt: "2024-01-01T00:00:00Z",
    endedAt: null,
    status: "success",
    exitCode: 0,
    totalAttemptCount: 1,
    maxAttemptsPerSession: 4,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: "sess-old",
    runtimeVars: {},
    brief: null,
    callerInstructions: null,
    finalTasks: {},
    totalSessionCount: 1,
    sessions: [],
    attemptRecords: [],
    archivedAt: null,
  };
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(v7Manifest, null, 2)}\n`);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => resolveResumeTarget("stale07", dir),
      (err) => {
        assert.match(err.message, /schemaVersion 7/);
        assert.match(err.message, /requires schemaVersion 14/);
        return true;
      },
    );
  });
});

test("schemaVersion mismatch: resume rejects a v10 manifest with a clear error", async () => {
  const dir = tempDir();
  const workspaceDir = join(dir, "runs", "unknown", "stale10");
  mkdirSync(workspaceDir, { recursive: true });
  const v10Manifest = {
    schemaVersion: 10,
    runId: "stale10",
    agent: { name: "old", sourcePath: "/tmp/agent.md", instructions: "" },
    assignment: null,
    backend: "claude",
    model: null,
    effort: null,
    message: null,
    name: null,
    unrestricted: false,
    cwd: dir,
    lockedFields: [],
    timeoutSec: 3600,
    assignmentPath: join(workspaceDir, "assignment.md"),
    workspaceDir,
    startedAt: "2024-01-01T00:00:00Z",
    endedAt: null,
    status: "success",
    exitCode: 0,
    attempts: 1,
    maxAttempts: 4,
    tasksCompleted: 0,
    tasksTotal: 0,
    backendSessionId: "sess-old",
    runtimeVars: {},
    brief: null,
    callerInstructions: null,
    finalTasks: {},
    sessionCount: 0,
    sessions: [],
    attemptRecords: [],
    archivedAt: null,
  };
  writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(v10Manifest, null, 2)}\n`);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => resolveResumeTarget("stale10", dir),
      (err) => {
        assert.match(err.message, /schemaVersion 10/);
        assert.match(err.message, /requires schemaVersion 14/);
        return true;
      },
    );
  });
});

test("schemaVersion mismatch: resume rejects a v12 manifest with the v14 migration hint", async () => {
  const dir = tempDir();
  const workspaceDir = join(dir, "runs", "unknown", "stale12");
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(workspaceDir, "run.json"),
    `${JSON.stringify({ schemaVersion: 12, runId: "stale12", workspaceDir }, null, 2)}\n`,
  );

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => resolveResumeTarget("stale12", dir),
      (err) => {
        assert.match(err.message, /schemaVersion 12/);
        assert.match(err.message, /requires schemaVersion 14/);
        assert.match(err.message, /scripts\/migrate-manifests-v14\.mjs/);
        return true;
      },
    );
  });
});

test("resume manifest: model + timeoutSec preserved across an init-run cycle", async () => {
  const dir = tempDir();
  writeAgent(dir, "canonical-claude", CLAUDE_AGENT);
  writeAssignment(dir, "canonical-work", BASIC_ASSIGNMENT);

  // Fresh run (no init) — writes the manifest with agent frontmatter values.
  const afterRun = await freshRun(dir, {
    initialize: false,
    backend: okBackend(),
  });

  // Model is locked at "claude-sonnet-4-6" via frontmatter
  // lockedFields: [model], so we can't test a --model CLI override
  // on this agent. Assert the write path preserves the frozen values
  // instead.
  const m = readManifest(afterRun.workspaceDir);
  assert.equal(m.model, "claude-sonnet-4-6", "model preserved on fresh run write");
  assert.equal(m.timeoutSec, 1800, "timeoutSec preserved on fresh run write");
});
