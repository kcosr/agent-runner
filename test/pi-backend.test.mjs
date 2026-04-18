import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  buildPiArgs,
  encodePiSessionDir,
  findPiSessionFile,
  piBackend,
  readPiSessionHeader,
} from "../packages/core/dist/backends/pi.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-pi-"));
}

function writeFakePiAgent(baseDir) {
  const path = join(baseDir, "fake-pi-agent.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { createInterface } from "node:readline";

const args = process.argv.slice(2);
const sessionFlagIndex = args.indexOf("--session");
const sessionFile =
  process.env.PI_TEST_SESSION_FILE ??
  (sessionFlagIndex >= 0 ? args[sessionFlagIndex + 1] : \`\${process.cwd()}/fake-session.jsonl\`);
const rawStartupLine = process.env.PI_TEST_RAW_STDOUT_LINE ?? "";
const promptEvents = JSON.parse(process.env.PI_TEST_PROMPT_EVENTS_JSON ?? "[]");
const renameCallsPath = process.env.PI_TEST_RENAME_CALLS_PATH;
const extensionResponsePath = process.env.PI_TEST_EXTENSION_RESPONSE_PATH;
const promptResponses = [];

if (process.env.PI_TEST_ARGS_PATH) {
  writeFileSync(process.env.PI_TEST_ARGS_PATH, JSON.stringify(args));
}
if (process.env.PI_TEST_CWD_PATH) {
  writeFileSync(process.env.PI_TEST_CWD_PATH, process.cwd());
}
if (process.env.PI_TEST_STDERR_TEXT) {
  process.stderr.write(process.env.PI_TEST_STDERR_TEXT);
}
if (rawStartupLine.length > 0) {
  process.stdout.write(rawStartupLine);
}

function send(obj) {
  process.stdout.write(JSON.stringify(obj) + "\\n");
}

function appendRename(name) {
  if (!renameCallsPath) return;
  promptResponses.push(name);
  writeFileSync(renameCallsPath, JSON.stringify(promptResponses));
}

function emitPromptEvents() {
  for (const entry of promptEvents) {
    if (typeof entry === "string") {
      process.stdout.write(entry);
    } else {
      send(entry);
    }
  }
  if (process.env.PI_TEST_EXIT_AFTER_PROMPT === "1") {
    setImmediate(() => {
      process.exit(Number(process.env.PI_TEST_EXIT_CODE ?? "0"));
    });
  }
}

const rl = createInterface({ input: process.stdin });
let waitingForExtensionResponse = false;
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "extension_ui_response") {
    if (extensionResponsePath) {
      writeFileSync(extensionResponsePath, JSON.stringify(message));
    }
    if (waitingForExtensionResponse) {
      waitingForExtensionResponse = false;
      emitPromptEvents();
    }
    return;
  }
  if (message.type === "get_state") {
    send({
      id: message.id,
      type: "response",
      command: "get_state",
      success: true,
      data: {
        sessionFile,
        sessionId: "pi-session-1",
        isStreaming: false,
      },
    });
    return;
  }
  if (message.type === "set_session_name") {
    appendRename(message.name);
    if (process.env.PI_TEST_FAIL_RENAME === "1") {
      send({
        id: message.id,
        type: "response",
        command: "set_session_name",
        success: false,
        error: "rename failed",
      });
      return;
    }
    send({
      id: message.id,
      type: "response",
      command: "set_session_name",
      success: true,
    });
    return;
  }
  if (message.type === "prompt") {
    send({
      id: message.id,
      type: "response",
      command: "prompt",
      success: true,
    });
    if (process.env.PI_TEST_REQUIRE_EXTENSION_CANCEL === "1") {
      waitingForExtensionResponse = true;
      send({
        type: "extension_ui_request",
        id: "ext-1",
        method: "confirm",
        title: "Need confirmation",
        message: "continue?",
      });
      return;
    }
    emitPromptEvents();
    return;
  }
  if (message.type === "abort") {
    send({
      id: message.id,
      type: "response",
      command: "abort",
      success: true,
    });
    send({ type: "agent_end", messages: [] });
  }
});

rl.on("close", () => {
  process.exit(Number(process.env.PI_TEST_EXIT_CODE ?? "0"));
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

function failAfter(ms, message) {
  return new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms));
}

test("encodePiSessionDir preserves dots and wraps cwd buckets with sentinels", () => {
  assert.equal(encodePiSessionDir("/home/kevin/assistant"), "--home-kevin-assistant--");
  assert.equal(encodePiSessionDir("/home/kevin/.agents"), "--home-kevin-.agents--");
});

test("buildPiArgs wires rpc mode, thinking, and session id resume", () => {
  assert.deepEqual(
    buildPiArgs({
      model: "openai/gpt-5.4",
      effort: "max",
      resumeSessionId: "pi-session-1",
    }),
    [
      "--mode",
      "rpc",
      "--no-themes",
      "--model",
      "openai/gpt-5.4",
      "--thinking",
      "xhigh",
      "--session",
      "pi-session-1",
    ],
  );
});

test("findPiSessionFile locates a session id inside the cwd-scoped Pi bucket", async () => {
  const dir = tempDir();
  const piHome = join(dir, ".pi-home");
  const bucketDir = join(piHome, "agent", "sessions", encodePiSessionDir(dir));
  const sessionPath = join(bucketDir, "2026-04-18T01-22-57-578Z_pi-session-1.jsonl");
  mkdirSync(bucketDir, { recursive: true });
  writeFileSync(sessionPath, `${JSON.stringify({ type: "session", cwd: dir })}\n`);

  await withEnv({ PI_HOME: piHome }, () => {
    assert.equal(findPiSessionFile(dir, "pi-session-1"), sessionPath);
  });
});

test("readPiSessionHeader parses the session cwd from the JSONL header", () => {
  const dir = tempDir();
  const sessionPath = join(dir, "pi-session.jsonl");
  writeFileSync(
    sessionPath,
    `${JSON.stringify({
      type: "session",
      version: 3,
      id: "pi-session-1",
      timestamp: "2026-04-17T12:00:00.000Z",
      cwd: dir,
    })}\n`,
  );

  assert.deepEqual(readPiSessionHeader(sessionPath), {
    type: "session",
    cwd: dir,
  });
});

test("pi backend launches in rpc mode, captures streamed text, and persists transcript", async () => {
  const dir = tempDir();
  const argsPath = join(dir, "args.json");
  const cwdPath = join(dir, "cwd.txt");
  const renameCallsPath = join(dir, "rename-calls.json");
  const command = writeFakePiAgent(dir);
  const events = [];

  const result = await withEnv({ TASK_RUNNER_PI_BIN: command }, () =>
    piBackend.invoke({
      prompt: "Inspect the repo",
      cwd: dir,
      env: {
        ...process.env,
        PI_TEST_ARGS_PATH: argsPath,
        PI_TEST_CWD_PATH: cwdPath,
        PI_TEST_RENAME_CALLS_PATH: renameCallsPath,
        PI_TEST_SESSION_FILE: join(dir, "session.jsonl"),
        PI_TEST_PROMPT_EVENTS_JSON: JSON.stringify([
          { type: "message_start", message: { role: "assistant", content: [] } },
          {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "Hello" }] },
          },
          {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "Hello world." }] },
          },
          {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "Hello world." }] },
          },
          { type: "message_start", message: { role: "assistant", content: [] } },
          {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "Next message." }] },
          },
          {
            type: "message_end",
            message: { role: "assistant", content: [{ type: "text", text: "Next message." }] },
          },
          { type: "agent_end", messages: [] },
        ]),
      },
      model: "openai/gpt-5.4",
      effort: "high",
      resumeSessionId: "pi-prev-session",
      name: "Pi invoke name",
      timeoutSec: 10,
      emit: (event) => events.push(event),
    }),
  );

  assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
    "--mode",
    "rpc",
    "--no-themes",
    "--model",
    "openai/gpt-5.4",
    "--thinking",
    "high",
    "--session",
    "pi-prev-session",
  ]);
  assert.equal(readFileSync(cwdPath, "utf8"), dir);
  assert.deepEqual(JSON.parse(readFileSync(renameCallsPath, "utf8")), ["Pi invoke name"]);
  assert.equal(result.sessionId, "pi-session-1");
  assert.equal(result.transcript, "Hello world.\n\nNext message.");
  assert.deepEqual(
    events.filter((event) => event.type === "agent_message_delta").map((event) => event.text),
    ["Hello", " world.", "\n\n", "Next message."],
  );
});

test("pi backend rejects malformed rpc output", async () => {
  const dir = tempDir();
  const command = writeFakePiAgent(dir);

  await assert.rejects(
    () =>
      withEnv({ TASK_RUNNER_PI_BIN: command }, () =>
        piBackend.invoke({
          prompt: "Inspect the repo",
          cwd: dir,
          env: {
            ...process.env,
            PI_TEST_RAW_STDOUT_LINE: "not-json\\n",
          },
          timeoutSec: 10,
        }),
      ),
    /non-JSON line/,
  );
});

test("pi backend auto-cancels dialog-style extension ui requests without hanging", async () => {
  const dir = tempDir();
  const command = writeFakePiAgent(dir);
  const extensionResponsePath = join(dir, "extension-response.json");

  const result = await Promise.race([
    withEnv({ TASK_RUNNER_PI_BIN: command }, () =>
      piBackend.invoke({
        prompt: "Inspect the repo",
        cwd: dir,
        env: {
          ...process.env,
          PI_TEST_EXTENSION_RESPONSE_PATH: extensionResponsePath,
          PI_TEST_REQUIRE_EXTENSION_CANCEL: "1",
          PI_TEST_PROMPT_EVENTS_JSON: JSON.stringify([
            { type: "message_start", message: { role: "assistant", content: [] } },
            {
              type: "message_end",
              message: { role: "assistant", content: [{ type: "text", text: "Recovered" }] },
            },
            { type: "agent_end", messages: [] },
          ]),
        },
        timeoutSec: 10,
      }),
    ),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("pi backend hung on extension ui request")), 2_000),
    ),
  ]);

  assert.equal(result.transcript, "Recovered");
  assert.deepEqual(JSON.parse(readFileSync(extensionResponsePath, "utf8")), {
    type: "extension_ui_response",
    id: "ext-1",
    cancelled: true,
  });
});

test("pi backend rejects when the process exits before agent_end", async () => {
  const dir = tempDir();
  const command = writeFakePiAgent(dir);

  await assert.rejects(
    () =>
      Promise.race([
        withEnv({ TASK_RUNNER_PI_BIN: command }, () =>
          piBackend.invoke({
            prompt: "Inspect the repo",
            cwd: dir,
            env: {
              ...process.env,
              PI_TEST_PROMPT_EVENTS_JSON: JSON.stringify([
                { type: "message_start", message: { role: "assistant", content: [] } },
                {
                  type: "message_end",
                  message: { role: "assistant", content: [{ type: "text", text: "Partial" }] },
                },
              ]),
              PI_TEST_EXIT_AFTER_PROMPT: "1",
            },
            timeoutSec: 10,
          }),
        ),
        failAfter(2_000, "pi backend hung after exiting without agent_end"),
      ]),
    /pi exited before finishing/,
  );
});

test("pi backend rejects cleanly when the pi binary is missing", async () => {
  const dir = tempDir();

  await assert.rejects(
    () =>
      Promise.race([
        withEnv({ TASK_RUNNER_PI_BIN: join(dir, "missing-pi-bin") }, () =>
          piBackend.invoke({
            prompt: "Inspect the repo",
            cwd: dir,
            timeoutSec: 10,
          }),
        ),
        failAfter(2_000, "pi backend hung on missing binary"),
      ]),
    /ENOENT|spawn/,
  );
});
