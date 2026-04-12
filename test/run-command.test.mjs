import { strict as assert } from "node:assert";
import { test } from "node:test";
import { ResumeError, executeRunCommand } from "../dist/core/run/execute-command.js";
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
