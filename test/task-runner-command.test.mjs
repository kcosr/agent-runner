import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { resolveTaskRunnerCommand } from "../dist/task-runner-command.js";

function makeExecutableDir() {
  const dir = mkdtempSync(join(tmpdir(), "task-runner-cmd-"));
  const binary = join(dir, "task-runner");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(binary, 0o755);
  return { dir, binary };
}

test("resolveTaskRunnerCommand: returns TASK_RUNNER_CMD when configured", () => {
  assert.equal(
    resolveTaskRunnerCommand({
      TASK_RUNNER_CMD: "/custom/bin/task-runner-dev",
      PATH: "",
    }),
    "/custom/bin/task-runner-dev",
  );
});

test("resolveTaskRunnerCommand: whitespace TASK_RUNNER_CMD falls through to PATH lookup", () => {
  const { dir, binary } = makeExecutableDir();
  assert.equal(
    resolveTaskRunnerCommand({
      TASK_RUNNER_CMD: "   ",
      PATH: `${dir}${delimiter}/usr/bin`,
    }),
    binary,
  );
});

test("resolveTaskRunnerCommand: returns PATH match when task-runner is executable", () => {
  const { dir, binary } = makeExecutableDir();
  assert.equal(
    resolveTaskRunnerCommand({
      PATH: `/usr/bin${delimiter}${dir}`,
    }),
    binary,
  );
});

test("resolveTaskRunnerCommand: falls back to bare task-runner when nothing is configured", () => {
  assert.equal(
    resolveTaskRunnerCommand({
      PATH: "",
    }),
    "task-runner",
  );
});
