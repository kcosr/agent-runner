import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { resolveAgentRunnerCommand } from "../packages/core/dist/agent-runner-command.js";

function makeExecutableDir() {
  const dir = mkdtempSync(join(tmpdir(), "agent-runner-cmd-"));
  const binary = join(dir, "agent-runner");
  writeFileSync(binary, "#!/bin/sh\nexit 0\n", "utf8");
  chmodSync(binary, 0o755);
  return { dir, binary };
}

test("resolveAgentRunnerCommand: returns AGENT_RUNNER_CMD when configured", () => {
  assert.equal(
    resolveAgentRunnerCommand({
      AGENT_RUNNER_CMD: "/custom/bin/agent-runner-dev",
      PATH: "",
    }),
    "/custom/bin/agent-runner-dev",
  );
});

test("resolveAgentRunnerCommand: whitespace AGENT_RUNNER_CMD falls through to PATH lookup", () => {
  const { dir, binary } = makeExecutableDir();
  assert.equal(
    resolveAgentRunnerCommand({
      AGENT_RUNNER_CMD: "   ",
      PATH: `${dir}${delimiter}/usr/bin`,
    }),
    binary,
  );
});

test("resolveAgentRunnerCommand: returns PATH match when agent-runner is executable", () => {
  const { dir, binary } = makeExecutableDir();
  assert.equal(
    resolveAgentRunnerCommand({
      PATH: `/usr/bin${delimiter}${dir}`,
    }),
    binary,
  );
});

test("resolveAgentRunnerCommand: falls back to bare agent-runner when nothing is configured", () => {
  assert.equal(
    resolveAgentRunnerCommand({
      PATH: "",
    }),
    "agent-runner",
  );
});
