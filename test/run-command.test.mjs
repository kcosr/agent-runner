import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { encodePiSessionDir } from "../packages/core/dist/backends/pi.js";
import { reconfigureInitializedRun } from "../packages/core/dist/core/run/reconfigure.js";
import {
  ResumeError,
  RunCommandError,
  executeRunCommand,
} from "../packages/core/dist/run-command.js";
import { idFor, writeCursorStore } from "./helpers/cursor-store.mjs";
import { withEnv, withRuntimeRoots } from "./helpers/runtime-paths.mjs";

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), body);
}

function writeEnvironment(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "environments");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), body);
}

function writeBackend(baseDir, name, body) {
  const dir = join(baseDir, "backends", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "backend.mjs"), body);
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

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function writePiSession(piHome, cwd, sessionId) {
  const bucketDir = join(piHome, "agent", "sessions", encodePiSessionDir(cwd));
  mkdirSync(bucketDir, { recursive: true });
  writeFileSync(
    join(bucketDir, `2026-05-01T00-00-00-000Z_${sessionId}.jsonl`),
    `${[
      { type: "session", cwd },
      {
        type: "message",
        id: "pi-user-1",
        timestamp: "2026-05-01T00:00:00.000Z",
        message: { role: "user", content: "Question" },
      },
      {
        type: "message",
        timestamp: "2026-05-01T00:00:01.000Z",
        message: { role: "assistant", content: "Answer" },
      },
    ]
      .map((record) => JSON.stringify(record))
      .join("\n")}\n`,
  );
}

test("executeRunCommand can initialize an ad-hoc passive run without an agent file", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "passive",
        message: "Seed an ad-hoc passive run.",
      },
    });

    assert.equal(outcome.manifest.status, "initialized");
    assert.equal(outcome.manifest.agent.name, "ad-hoc");
    assert.equal(outcome.manifest.agent.sourcePath, null);
    assert.equal(outcome.manifest.backend, "passive");
  }));

test("executeRunCommand resolves selected environment vars as run vars", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ configDir, stateDir }) => {
    writeEnvironment(
      configDir,
      "clone-runtime",
      `schemaVersion: 1
kind: container
mode: existing
engine: podman
cwd: /workspace/{{repo_name}}
vars:
  repo_name:
    sources: [cli]
    required: true
  base_ref:
    sources: [cli]
    default: main
container: runtime-box
`,
    );
    writeAgent(
      configDir,
      "worker",
      `---
schemaVersion: 1
name: worker
backend: codex
---
Inspect the repository.
`,
    );
    writeAssignment(
      configDir,
      "inspect",
      `---
schemaVersion: 1
name: inspect
cwd: "{{state_dir}}/assigned/{{repo_name}}"
tasks: []
---
Explain {{repo_name}}.
`,
    );

    const outcome = await executeRunCommand({
      initialize: true,
      agent: "worker",
      assignment: "inspect",
      cliVars: { repo_name: "demo" },
      overrides: {
        executionEnvironment: "clone-runtime",
        message: "Explain this app.",
      },
    });

    assert.equal(outcome.manifest.cwd, join(stateDir, "assigned", "demo"));
    assert.deepEqual(outcome.manifest.runtimeVars, {
      repo_name: "demo",
      base_ref: "main",
    });
    assert.deepEqual(outcome.manifest.resetSeed.runtimeVars, outcome.manifest.runtimeVars);
    assert.equal(outcome.manifest.executionEnvironment.cwd, "/workspace/demo");
  }));

test("executeRunCommand invokes containerized backends with the execution cwd", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ rootDir, configDir }) => {
    const binDir = join(rootDir, "bin");
    const capturePath = join(rootDir, "backend-capture.json");
    mkdirSync(binDir, { recursive: true });
    writeFileSync(
      join(binDir, "docker"),
      `#!/usr/bin/env node
const args = process.argv.slice(2);
const [cmd, target] = args;
if (cmd === "inspect" && target === "agent-runner-run-123") process.exit(1);
if (cmd === "inspect") {
  process.stdout.write(JSON.stringify([{ Id: "container-123", State: { Running: true }, Mounts: [] }]));
  process.exit(0);
}
if (cmd === "run") {
  process.stdout.write("container-123\\n");
  process.exit(0);
}
process.exit(0);
`,
      { mode: 0o755 },
    );
    writeBackend(
      configDir,
      "capture",
      `import { writeFileSync } from "node:fs";
export default {
  id: "capture",
  async invoke(ctx) {
    writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({
      cwd: ctx.cwd,
      processCwd: ctx.processCwd,
      agentRunnerCwd: ctx.env.AGENT_RUNNER_CWD,
      launcherCommand: ctx.launcher?.command,
      launcherWorkdir: ctx.launcher?.args?.[ctx.launcher.args.indexOf("-w") + 1],
    }, null, 2));
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      sessionId: "capture-session",
      transcript: "ok",
      rawStdout: "",
      rawStderr: ""
    };
  }
};`,
    );
    writeEnvironment(
      configDir,
      "runtime",
      `schemaVersion: 1
kind: container
mode: managed
engine: docker
image: alpine:latest
cwd: /workspace
containerName: agent-runner-run-123
cleanup:
  policy: terminal
`,
    );

    const outcome = await withEnv({ PATH: `${binDir}:${process.env.PATH}` }, () =>
      executeRunCommand({
        initialize: false,
        cliVars: {},
        overrides: {
          backend: "capture",
          executionEnvironment: "runtime",
          message: "Inspect the repository.",
        },
      }),
    );

    assert.equal(outcome.manifest.cwd, process.cwd());
    assert.equal(outcome.manifest.executionEnvironment.cwd, "/workspace");
    assert.deepEqual(JSON.parse(readFileSync(capturePath, "utf8")), {
      cwd: "/workspace",
      processCwd: process.cwd(),
      agentRunnerCwd: "/workspace",
      launcherCommand: "docker",
      launcherWorkdir: "/workspace",
    });
  }));

test("executeRunCommand rejects conflicting assignment and environment var definitions", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ configDir }) => {
    writeEnvironment(
      configDir,
      "clone-runtime",
      `schemaVersion: 1
kind: container
mode: existing
cwd: /workspace/{{repo_name}}
vars:
  repo_name:
    type: string
    sources: [cli]
container: runtime-box
`,
    );
    writeAgent(
      configDir,
      "worker",
      `---
schemaVersion: 1
name: worker
backend: codex
---
Inspect the repository.
`,
    );
    writeAssignment(
      configDir,
      "inspect",
      `---
schemaVersion: 1
name: inspect
vars:
  repo_name:
    type: number
    sources: [cli]
tasks: []
---
Explain the repository.
`,
    );

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: true,
          agent: "worker",
          assignment: "inspect",
          cliVars: { repo_name: "demo" },
          overrides: {
            executionEnvironment: "clone-runtime",
            message: "Explain this app.",
          },
        }),
      /var "repo_name" is declared by both assignment\.vars and environment\.vars with different definitions/,
    );
  }));

test("reconfigureInitializedRun can edit vars introduced by the selected environment", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ configDir }) => {
    writeEnvironment(
      configDir,
      "clone-runtime",
      `schemaVersion: 1
kind: container
mode: existing
engine: podman
cwd: /workspace/{{repo_name}}
vars:
  repo_name:
    sources: [cli]
    required: true
container: runtime-box
`,
    );

    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: { repo_name: "demo" },
      overrides: {
        backend: "codex",
        executionEnvironment: "clone-runtime",
        message: "Explain this app.",
      },
    });

    const detail = await reconfigureInitializedRun(outcome.runId, {
      vars: { repo_name: "beta" },
    });
    assert.equal(detail.runtimeVars.repo_name, "beta");

    const manifest = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
    assert.equal(manifest.runtimeVars.repo_name, "beta");
    assert.equal(manifest.resetSeed.runtimeVars.repo_name, "beta");
    assert.equal(manifest.executionEnvironment.cwd, "/workspace/beta");
    assert.equal(manifest.resetSeed.executionEnvironment.cwd, "/workspace/beta");
  }));

test("reconfigureInitializedRun preserves environment var constraints", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ configDir }) => {
    writeEnvironment(
      configDir,
      "clone-runtime",
      `schemaVersion: 1
kind: container
mode: existing
cwd: /workspace/{{repo_kind}}
vars:
  repo_kind:
    type: enum
    values: [app, library]
    sources: [cli]
    required: true
container: runtime-box
`,
    );

    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: { repo_kind: "app" },
      overrides: {
        backend: "codex",
        executionEnvironment: "clone-runtime",
        message: "Explain this app.",
      },
    });

    await assert.rejects(
      () =>
        reconfigureInitializedRun(outcome.runId, {
          vars: { repo_kind: "service" },
        }),
      /var "repo_kind": expected one of app, library, got "service"/,
    );

    const manifest = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
    assert.equal(manifest.runtimeVars.repo_kind, "app");
    assert.equal(manifest.executionEnvironment.cwd, "/workspace/app");
  }));

test("reconfigureInitializedRun preserves group container identity", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ configDir }) => {
    writeEnvironment(
      configDir,
      "group-runtime",
      `schemaVersion: 1
kind: container
mode: managed
engine: podman
image: node:22
lifetime: group
containerName: "{{repo_name}}-box"
cwd: /workspace/{{repo_name}}
vars:
  repo_name:
    sources: [cli]
    required: true
`,
    );

    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: { repo_name: "demo" },
      overrides: {
        backend: "codex",
        executionEnvironment: "group-runtime",
        message: "Explain this app.",
      },
    });

    const before = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
    assert.equal(before.executionEnvironment.containerName, "demo-box");

    await reconfigureInitializedRun(outcome.runId, {
      vars: { repo_name: "beta" },
    });

    const after = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
    assert.equal(after.runtimeVars.repo_name, "beta");
    assert.equal(after.executionEnvironment.cwd, "/workspace/beta");
    assert.equal(after.executionEnvironment.containerName, "demo-box");
    assert.equal(after.resetSeed.executionEnvironment.containerName, "demo-box");
  }));

test("executeRunCommand rejects resume-time cli vars before attempting backend execution", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "passive",
        message: "Seed a resumable passive run.",
      },
    });
    patchManifest(outcome.workspaceDir, (manifest) => {
      manifest.backend = "claude";
      manifest.resetSeed.backend = "claude";
      manifest.status = "ready";
    });

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          resumeRun: outcome.runId,
          cliVars: { repo_path: "." },
          overrides: {
            message: "Resume with forbidden vars.",
          },
        }),
      (err) =>
        err instanceof ResumeError &&
        /--var cannot be combined with --resume-run/.test(err.message),
    );
  }));

test("executeRunCommand rejects initialized resume targets with a ready hint", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "claude",
        message: "Seed a resumable run.",
      },
    });

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          resumeRun: outcome.runId,
          cliVars: {},
          overrides: {},
        }),
      (err) =>
        err instanceof ResumeError && new RegExp(`run ready ${outcome.runId}`).test(err.message),
    );
  }));

test("executeRunCommand allows ready runs to start without a follow-up message", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "passive",
        message: "Seed a ready run.",
      },
    });

    patchManifest(outcome.workspaceDir, (manifest) => {
      manifest.backend = "claude";
      manifest.resetSeed.backend = "claude";
      manifest.status = "ready";
    });

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          resumeRun: outcome.runId,
          cliVars: {},
          overrides: {
            message: "forbidden override",
          },
        }),
      (err) =>
        err instanceof ResumeError &&
        /starting a ready run does not accept message/.test(err.message),
    );
  }));

test("executeRunCommand treats ready runs with prior sessions as resumes for message validation", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "claude",
        message: "Seed a recurring reuse run.",
      },
    });

    patchManifest(outcome.workspaceDir, (manifest) => {
      manifest.status = "ready";
      manifest.totalSessionCount = 1;
      manifest.sessions = [
        {
          sessionIndex: 0,
          firstAttemptNumber: 1,
          lastAttemptNumber: 1,
          startedAt: "2026-04-25T13:00:00.000Z",
          endedAt: "2026-04-25T13:01:00.000Z",
          status: "success",
          exitCode: 0,
          message: null,
          brief: manifest.brief,
          maxAttemptsPerSession: manifest.maxAttemptsPerSession,
          backendSessionIdAtStart: null,
          backendSessionIdAtEnd: null,
          provenance: { kind: "task_runner" },
        },
      ];
      manifest.totalAttemptCount = 1;
      manifest.backendSessionId = null;
    });

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          resumeRun: outcome.runId,
          cliVars: {},
          overrides: {
            message: "Resuming after scheduled delay.",
          },
        }),
      (err) =>
        err instanceof ResumeError &&
        /captured no backend session id/.test(err.message) &&
        !/starting a ready run does not accept message/.test(err.message),
    );
  }));

test("executeRunCommand allows empty resume preflight when incomplete tasks remain", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "passive",
        message: "Seed a resumable passive run.",
      },
    });

    const manifestPath = join(outcome.workspaceDir, "run.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.status = "blocked";
    manifest.endedAt = "2026-04-13T00:00:00.000Z";
    manifest.exitCode = 2;
    manifest.brief = "Resume the remaining task.";
    manifest.finalTasks = {
      t1: {
        id: "t1",
        title: "First",
        body: "",
        status: "pending",
        notes: "",
      },
    };
    manifest.tasksCompleted = 0;
    manifest.tasksTotal = 1;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          resumeRun: outcome.runId,
          cliVars: {},
          overrides: {},
        }),
      (err) =>
        err instanceof Error &&
        /cannot run passive agent/.test(err.message) &&
        !/follow-up message/.test(err.message),
    );
  }));

test("executeRunCommand requires --backend for ad-hoc bootstrap with a help-worthy error", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: true,
          cliVars: {},
          overrides: {
            message: "Bootstrap without an agent or backend.",
          },
        }),
      (err) =>
        err instanceof RunCommandError &&
        err.showHelp === true &&
        /--backend is required to synthesize an ad-hoc agent/.test(err.message),
    );
  }));

test("executeRunCommand rejects passive execution with a command-level error", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          cliVars: {},
          overrides: {
            backend: "passive",
            message: "Try to execute a passive run.",
          },
        }),
      (err) => err instanceof RunCommandError && /cannot run passive agent/.test(err.message),
    );
  }));

test("executeRunCommand accepts cursor bootstrap session import with a valid store", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ rootDir }) => {
    const sessionId = "cursor-chat-1";
    await withEnv({ HOME: rootDir }, async () => {
      writeCursorStore({
        cwd: process.cwd(),
        sessionId,
        messageIds: [idFor(1), idFor(2)],
        messages: [
          [idFor(1), { role: "user", content: "Question" }],
          [idFor(2), { role: "assistant", content: "Answer" }],
        ],
      });

      const outcome = await executeRunCommand({
        initialize: true,
        backendSessionId: sessionId,
        cliVars: {},
        overrides: {
          backend: "cursor",
          message: "Seed an ad-hoc cursor run.",
        },
      });

      assert.equal(outcome.manifest.status, "initialized");
      assert.equal(outcome.manifest.backend, "cursor");
      assert.equal(outcome.manifest.backendSessionId, sessionId);
      assert.equal(outcome.manifest.attemptRecords.length, 1);
      assert.equal(outcome.manifest.attemptRecords[0].provenance.kind, "backend_session");
      assert.equal(outcome.manifest.attemptRecords[0].provenance.backend, "cursor");
    });
  }));

test("executeRunCommand accepts pi bootstrap session import with a valid history file", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ rootDir }) => {
    const sessionId = "pi-session-1";
    await withEnv({ PI_HOME: rootDir }, async () => {
      writePiSession(rootDir, process.cwd(), sessionId);

      const outcome = await executeRunCommand({
        initialize: true,
        backendSessionId: sessionId,
        cliVars: {},
        overrides: {
          backend: "pi",
          message: "Seed an ad-hoc pi run.",
        },
      });

      assert.equal(outcome.manifest.status, "initialized");
      assert.equal(outcome.manifest.backend, "pi");
      assert.equal(outcome.manifest.backendSessionId, sessionId);
      assert.equal(outcome.manifest.attemptRecords.length, 1);
      assert.equal(outcome.manifest.attemptRecords[0].provenance.kind, "backend_session");
      assert.equal(outcome.manifest.attemptRecords[0].provenance.backend, "pi");
    });
  }));

test("executeRunCommand rejects launcher overrides on resume before backend execution", async () =>
  withRuntimeRoots("agent-runner-run-command-", async ({ configDir }) => {
    writeLauncher(
      configDir,
      "shared",
      `schemaVersion: 1
name: shared
command: env
args: [CODING=1]
`,
    );

    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "passive",
        launcher: "shared",
        message: "Seed a resumable passive run with a frozen launcher.",
      },
    });
    patchManifest(outcome.workspaceDir, (manifest) => {
      manifest.status = "ready";
    });

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          resumeRun: outcome.runId,
          cliVars: {},
          overrides: {
            launcher: "shared",
          },
        }),
      (err) =>
        err instanceof ResumeError &&
        /--launcher cannot be combined with --resume-run/.test(err.message),
    );
  }));

test("executeRunCommand rejects explicit parentRunId on resume", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "passive",
        message: "Seed a resumable passive run.",
      },
    });
    patchManifest(outcome.workspaceDir, (manifest) => {
      manifest.backend = "claude";
      manifest.resetSeed.backend = "claude";
      manifest.status = "ready";
    });

    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: false,
          resumeRun: outcome.runId,
          parentRunId: "parent-123",
          cliVars: {},
          overrides: {},
        }),
      (err) =>
        err instanceof ResumeError &&
        /--parent-run cannot be combined with --resume-run/.test(err.message),
    );
  }));

test("executeRunCommand ignores env-derived parentRunId on resume", async () =>
  withRuntimeRoots("agent-runner-run-command-", async () => {
    const outcome = await executeRunCommand({
      initialize: true,
      cliVars: {},
      overrides: {
        backend: "passive",
        message: "Seed a resumable passive run.",
      },
    });
    patchManifest(outcome.workspaceDir, (manifest) => {
      manifest.backend = "claude";
      manifest.resetSeed.backend = "claude";
      manifest.status = "ready";
    });

    await assert.rejects(
      () =>
        withEnv({ AGENT_RUNNER_PARENT_RUN_ID: "env-parent-1" }, () =>
          executeRunCommand({
            initialize: false,
            resumeRun: outcome.runId,
            cliVars: {},
            overrides: {
              message: "forbidden override",
            },
          }),
        ),
      (err) =>
        err instanceof ResumeError &&
        /starting a ready run does not accept message/.test(err.message),
    );
  }));
