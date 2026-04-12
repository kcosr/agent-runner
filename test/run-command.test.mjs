import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ResumeError, RunCommandError, executeRunCommand } from "../dist/run-command.js";
import { withRuntimeRoots } from "./helpers/runtime-paths.mjs";

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
