import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildCursorArgs, cursorBackend } from "../packages/core/dist/backends/cursor.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-cursor-"));
}

function writeFakeCursorAgent(baseDir) {
  const path = join(baseDir, "fake-cursor-agent.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.env.CURSOR_TEST_ARGS_PATH) {
  writeFileSync(process.env.CURSOR_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
}

for (const chunk of JSON.parse(process.env.CURSOR_TEST_STDOUT_JSON ?? "[]")) {
  process.stdout.write(chunk);
}
for (const chunk of JSON.parse(process.env.CURSOR_TEST_STDERR_JSON ?? "[]")) {
  process.stderr.write(chunk);
}

process.exit(Number(process.env.CURSOR_TEST_EXIT_CODE ?? "0"));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("buildCursorArgs builds the public print-mode argv", () => {
  assert.deepEqual(
    buildCursorArgs({
      cwd: "/tmp/repo",
      model: "provider/gpt-5.4",
      prompt: "Inspect the repo",
      resolvedBackendArgs: ["--model", "cursor-latest", "--new-flag"],
      resumeSessionId: "sess-prev",
      unrestricted: true,
    }),
    [
      "-p",
      "--trust",
      "--output-format",
      "stream-json",
      "--stream-partial-output",
      "--workspace",
      "/tmp/repo",
      "--model",
      "gpt-5.4",
      "--force",
      "--resume",
      "sess-prev",
      "--model",
      "cursor-latest",
      "--new-flag",
      "Inspect the repo",
    ],
  );
});

test("cursor backend merges streamed and final transcripts when they differ", async () => {
  const dir = tempDir();
  const argsPath = join(dir, "args.json");
  const command = writeFakeCursorAgent(dir);
  const events = [];

  const result = await withEnv({ TASK_RUNNER_CURSOR_BIN: command }, () =>
    cursorBackend.invoke({
      prompt: "Inspect the repo",
      cwd: dir,
      env: {
        ...process.env,
        CURSOR_TEST_ARGS_PATH: argsPath,
        CURSOR_TEST_STDOUT_JSON: JSON.stringify([
          `${JSON.stringify({ type: "partial_output", text: "Hello", meta: { session_id: "sess-123" } })}\n`,
          `${JSON.stringify({ type: "partial_output", text: " world" })}\n`,
          `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hello world" } })}\n`,
          `${JSON.stringify({ type: "tool_call", tool: "shell", arguments: "echo hi" })}\n`,
          `${JSON.stringify({ type: "result", result: "Final answer" })}\n`,
        ]),
      },
      model: "provider/gpt-5.4",
      resolvedBackendArgs: ["--model", "cursor-latest", "--new-flag"],
      unrestricted: true,
      timeoutSec: 10,
      resumeSessionId: "sess-prev",
      emit: (event) => events.push(event),
    }),
  );

  assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
    "-p",
    "--trust",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--workspace",
    dir,
    "--model",
    "gpt-5.4",
    "--force",
    "--resume",
    "sess-prev",
    "--model",
    "cursor-latest",
    "--new-flag",
    "Inspect the repo",
  ]);
  assert.equal(result.sessionId, "sess-123");
  assert.equal(result.transcript, "Hello world\n\n---\n\nFinal answer");
  assert.equal(
    events
      .filter((event) => event.type === "agent_message_delta")
      .map((event) => event.text)
      .join(""),
    "Hello world",
  );
});

test("cursor backend parses assistant stream-json chunks and top-level result", async () => {
  const dir = tempDir();
  const command = writeFakeCursorAgent(dir);
  const events = [];

  const result = await withEnv({ TASK_RUNNER_CURSOR_BIN: command }, () =>
    cursorBackend.invoke({
      prompt: "Still there?",
      cwd: dir,
      env: {
        ...process.env,
        CURSOR_TEST_STDOUT_JSON: JSON.stringify([
          `${JSON.stringify({ type: "system", subtype: "init", session_id: "sess-current" })}\n`,
          `${JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "text", text: "Still there?" }] }, session_id: "sess-current" })}\n`,
          `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Yep" }] }, session_id: "sess-current", timestamp_ms: 1 })}\n`,
          `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: " -" }] }, session_id: "sess-current", timestamp_ms: 2 })}\n`,
          `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: " still here." }] }, session_id: "sess-current", timestamp_ms: 3 })}\n`,
          `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "Yep - still here." }] }, session_id: "sess-current" })}\n`,
          `${JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "Yep - still here.", session_id: "sess-current" })}\n`,
        ]),
      },
      resolvedBackendArgs: [],
      timeoutSec: 10,
      emit: (event) => events.push(event),
    }),
  );

  assert.equal(result.exitCode, 0);
  assert.equal(result.sessionId, "sess-current");
  assert.equal(result.transcript, "Yep - still here.");
  assert.deepEqual(
    events.filter((event) => event.type === "agent_message_delta").map((event) => event.text),
    ["Yep", " -", " still here."],
  );
});

test("cursor backend rejects malformed stream-json output", async () => {
  const dir = tempDir();
  const command = writeFakeCursorAgent(dir);
  const rawStdoutLines = [];

  await assert.rejects(
    () =>
      withEnv({ TASK_RUNNER_CURSOR_BIN: command }, () =>
        cursorBackend.invoke({
          prompt: "Inspect the repo",
          cwd: dir,
          env: {
            ...process.env,
            CURSOR_TEST_STDOUT_JSON: JSON.stringify(["not-json\n", "still-raw\n", "tail"]),
          },
          resolvedBackendArgs: [],
          timeoutSec: 10,
          onRawStdoutLine: (line) => rawStdoutLines.push(line),
        }),
      ),
    /non-JSON line/,
  );
  assert.deepEqual(rawStdoutLines, ["not-json\n", "still-raw\n", "tail"]);
});

test("cursor backend rejects successful runs without a final result string", async () => {
  const dir = tempDir();
  const command = writeFakeCursorAgent(dir);

  await assert.rejects(
    () =>
      withEnv({ TASK_RUNNER_CURSOR_BIN: command }, () =>
        cursorBackend.invoke({
          prompt: "Inspect the repo",
          cwd: dir,
          env: {
            ...process.env,
            CURSOR_TEST_STDOUT_JSON: JSON.stringify([
              `${JSON.stringify({ type: "partial_output", text: "Hello" })}\n`,
            ]),
          },
          resolvedBackendArgs: [],
          timeoutSec: 10,
        }),
      ),
    /without a valid final result string/,
  );
});

test("cursor backend returns non-zero exits without guessing a transcript", async () => {
  const dir = tempDir();
  const command = writeFakeCursorAgent(dir);

  const result = await withEnv({ TASK_RUNNER_CURSOR_BIN: command }, () =>
    cursorBackend.invoke({
      prompt: "Inspect the repo",
      cwd: dir,
      env: {
        ...process.env,
        CURSOR_TEST_STDOUT_JSON: JSON.stringify([
          `${JSON.stringify({ type: "partial_output", text: "Partial output" })}\n`,
        ]),
        CURSOR_TEST_STDERR_JSON: JSON.stringify(["cursor failed\n"]),
        CURSOR_TEST_EXIT_CODE: "1",
      },
      resolvedBackendArgs: [],
      timeoutSec: 10,
    }),
  );

  assert.equal(result.exitCode, 1);
  assert.equal(result.transcript, null);
  assert.equal(result.rawStderr, "cursor failed\n");
});

test("cursor backend inserts a boundary separator before the next partial output", async () => {
  const dir = tempDir();
  const command = writeFakeCursorAgent(dir);
  const events = [];

  await withEnv({ TASK_RUNNER_CURSOR_BIN: command }, () =>
    cursorBackend.invoke({
      prompt: "Inspect the repo",
      cwd: dir,
      env: {
        ...process.env,
        CURSOR_TEST_STDOUT_JSON: JSON.stringify([
          `${JSON.stringify({ type: "partial_output", text: "Hello world." })}\n`,
          `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Hello world." } })}\n`,
          `${JSON.stringify({ type: "partial_output", text: "Next message." })}\n`,
          `${JSON.stringify({ type: "result", result: "Final answer" })}\n`,
        ]),
      },
      resolvedBackendArgs: [],
      timeoutSec: 10,
      emit: (event) => events.push(event),
    }),
  );

  assert.deepEqual(
    events.filter((event) => event.type === "agent_message_delta").map((event) => event.text),
    ["Hello world.", "\n\n", "Next message."],
  );
});

test("cursor backend emits a fallback delta when only the final result transcript exists", async () => {
  const dir = tempDir();
  const command = writeFakeCursorAgent(dir);
  const events = [];

  const result = await withEnv({ TASK_RUNNER_CURSOR_BIN: command }, () =>
    cursorBackend.invoke({
      prompt: "Inspect the repo",
      cwd: dir,
      env: {
        ...process.env,
        CURSOR_TEST_STDOUT_JSON: JSON.stringify([
          `${JSON.stringify({ type: "assistant", message: { role: "assistant", content: "Final answer" } })}\n`,
          `${JSON.stringify({ type: "result", result: "Final answer" })}\n`,
        ]),
      },
      resolvedBackendArgs: [],
      timeoutSec: 10,
      emit: (event) => events.push(event),
    }),
  );

  assert.equal(result.transcript, "Final answer");
  assert.deepEqual(
    events.filter((event) => event.type === "agent_message_delta").map((event) => event.text),
    ["Final answer"],
  );
});
