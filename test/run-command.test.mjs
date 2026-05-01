import { strict as assert } from "node:assert";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import {
  ResumeError,
  RunCommandError,
  executeRunCommand,
} from "../packages/core/dist/run-command.js";
import { withEnv, withRuntimeRoots } from "./helpers/runtime-paths.mjs";

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${name}${ext}`), body);
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

test("executeRunCommand can initialize an ad-hoc passive run without an agent file", async () =>
  withRuntimeRoots("task-runner-run-command-", async () => {
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

test("executeRunCommand rejects resume-time cli vars before attempting backend execution", async () =>
  withRuntimeRoots("task-runner-run-command-", async () => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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

test("executeRunCommand rejects cursor bootstrap session import with a command-level error", async () =>
  withRuntimeRoots("task-runner-run-command-", async () => {
    await assert.rejects(
      () =>
        executeRunCommand({
          initialize: true,
          backendSessionId: "cursor-chat-1",
          cliVars: {},
          overrides: {
            backend: "cursor",
            message: "Seed an ad-hoc cursor run.",
          },
        }),
      (err) =>
        err instanceof RunCommandError &&
        /--backend-session-id is unsupported for cursor/.test(err.message),
    );
  }));

test("executeRunCommand rejects launcher overrides on resume before backend execution", async () =>
  withRuntimeRoots("task-runner-run-command-", async ({ configDir }) => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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
  withRuntimeRoots("task-runner-run-command-", async () => {
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
        withEnv({ TASK_RUNNER_PARENT_RUN_ID: "env-parent-1" }, () =>
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
