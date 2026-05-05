import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildOpenCodeArgs, opencodeBackend } from "../packages/core/dist/backends/opencode.js";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-opencode-"));
}

function writeFakeOpenCodeBin(baseDir) {
  const path = join(baseDir, "fake-opencode.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.env.OPENCODE_TEST_ARGS_PATH) {
  writeFileSync(process.env.OPENCODE_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
}

for (const chunk of JSON.parse(process.env.OPENCODE_TEST_STDOUT_JSON ?? "[]")) {
  process.stdout.write(chunk);
}
for (const chunk of JSON.parse(process.env.OPENCODE_TEST_STDERR_JSON ?? "[]")) {
  process.stderr.write(chunk);
}

process.exit(Number(process.env.OPENCODE_TEST_EXIT_CODE ?? "0"));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("buildOpenCodeArgs builds headless json argv", () => {
  assert.deepEqual(
    buildOpenCodeArgs({
      prompt: "Inspect the repo",
      model: "anthropic/claude-sonnet-4-5",
      effort: "xhigh",
      name: "OpenCode invoke name",
      resolvedBackendArgs: ["--agent", "build"],
      resumeSessionId: "ses_prev",
      unrestricted: true,
    }),
    [
      "run",
      "--format",
      "json",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "--variant",
      "max",
      "--session",
      "ses_prev",
      "--title",
      "OpenCode invoke name",
      "--dangerously-skip-permissions",
      "--agent",
      "build",
      "Inspect the repo",
    ],
  );
});

test("buildOpenCodeArgs omits optional flags and blank prompts", () => {
  assert.deepEqual(
    buildOpenCodeArgs({
      prompt: "   ",
      resolvedBackendArgs: [],
      unrestricted: false,
    }),
    ["run", "--format", "json"],
  );
});

test("opencode backend treats session error events as failed attempts", async () => {
  const dir = tempDir();
  const command = writeFakeOpenCodeBin(dir);
  const events = [];

  try {
    const result = await opencodeBackend.invoke({
      prompt: "Inspect the repo",
      cwd: dir,
      env: {
        ...process.env,
        TASK_RUNNER_OPENCODE_BIN: command,
        OPENCODE_TEST_STDOUT_JSON: JSON.stringify([
          `${JSON.stringify({ type: "server.connected", sessionID: "ses_123" })}\n`,
          `${JSON.stringify({
            type: "error",
            sessionID: "ses_123",
            error: { data: { message: "provider failed" } },
          })}\n`,
        ]),
      },
      resolvedBackendArgs: [],
      timeoutSec: 10,
      emit: (event) => events.push(event),
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.sessionId, "ses_123");
    assert.equal(
      events.some((event) => event.type === "backend_notice" && event.text === "provider failed"),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("opencode backend captures session id and completed text events", async () => {
  const dir = tempDir();
  const argsPath = join(dir, "args.json");
  const command = writeFakeOpenCodeBin(dir);
  const events = [];
  const rawStdoutLines = [];

  try {
    const result = await opencodeBackend.invoke({
      prompt: "Inspect the repo",
      cwd: dir,
      env: {
        ...process.env,
        TASK_RUNNER_OPENCODE_BIN: command,
        OPENCODE_TEST_ARGS_PATH: argsPath,
        OPENCODE_TEST_STDOUT_JSON: JSON.stringify([
          `${JSON.stringify({ type: "server.connected", sessionID: "ses_123" })}\n`,
          `${JSON.stringify({
            type: "text",
            timestamp: 1,
            sessionID: "ses_123",
            part: { type: "text", text: "Hello" },
          })}\r\n`,
          `${JSON.stringify({
            type: "text",
            timestamp: 2,
            sessionID: "ses_123",
            part: { type: "text", text: "world" },
          })}\n`,
          "tail-partial",
        ]),
        OPENCODE_TEST_STDERR_JSON: JSON.stringify(["notice"]),
      },
      model: "anthropic/claude-sonnet-4-5",
      effort: "xhigh",
      name: "OpenCode invoke name",
      resolvedBackendArgs: ["--agent", "build"],
      unrestricted: true,
      timeoutSec: 10,
      resumeSessionId: "ses_prev",
      emit: (event) => events.push(event),
      onRawStdoutLine: (line) => rawStdoutLines.push(line),
    });

    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
      "run",
      "--format",
      "json",
      "--model",
      "anthropic/claude-sonnet-4-5",
      "--variant",
      "max",
      "--session",
      "ses_prev",
      "--title",
      "OpenCode invoke name",
      "--dangerously-skip-permissions",
      "--agent",
      "build",
      "Inspect the repo",
    ]);
    assert.equal(result.exitCode, 0, `${result.rawStderr}\n${result.rawStdout}`);
    assert.equal(result.sessionId, "ses_123");
    assert.equal(result.transcript, "Hello\n\nworld");
    assert.deepEqual(rawStdoutLines, [
      `${JSON.stringify({ type: "server.connected", sessionID: "ses_123" })}\n`,
      `${JSON.stringify({
        type: "text",
        timestamp: 1,
        sessionID: "ses_123",
        part: { type: "text", text: "Hello" },
      })}\r\n`,
      `${JSON.stringify({
        type: "text",
        timestamp: 2,
        sessionID: "ses_123",
        part: { type: "text", text: "world" },
      })}\n`,
      "tail-partial",
    ]);
    assert.deepEqual(
      events.filter((event) => event.type === "agent_message_delta").map((event) => event.text),
      ["Hello", "\n\nworld"],
    );
    assert.equal(
      events.some((event) => event.type === "backend_notice" && event.text === "notice"),
      true,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
