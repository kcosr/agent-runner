import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  buildCodexAppServerArgs,
  buildCodexThreadParams,
  buildCodexTurnStartPayload,
  codexBackend,
  normalizeCodexUdsPath,
  normalizeCodexWsUrl,
  resolveCodexBackendConfig,
  resolveCodexTransportConfig,
} from "../packages/core/dist/backends/codex.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

const baseCtx = {
  cwd: "/repo",
  env: {},
  prompt: "ignored",
  resolvedBackendArgs: [],
  timeoutSec: 60,
};

function writeFakeCodexBin(baseDir) {
  const path = join(baseDir, "fake-codex.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { createInterface } from "node:readline";

const mode = process.env.CODEX_TEST_MODE ?? "normal";
const rl = createInterface({ input: process.stdin });

if (mode === "normal") {
  process.stdout.write("\\n");
  process.stdout.write("   \\n");
}

function send(message) {
  process.stdout.write(JSON.stringify(message) + "\\n");
}

function notify(method, params) {
  send({ jsonrpc: "2.0", method, params });
}

rl.on("line", (line) => {
  if (mode === "malformed") {
    process.stdout.write("{not-json\\n");
    process.stdout.write("raw-after-malformed\\n");
    process.stdout.write("tail-after-malformed");
    setImmediate(() => process.exit(0));
    return;
  }

  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
    return;
  }
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "thread/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { thread: { id: "stdio-thread" } } });
    return;
  }
  if (message.method === "turn/start") {
    send({ jsonrpc: "2.0", id: message.id, result: { turn: { id: "stdio-turn" } } });
    setTimeout(() => {
      notify("item/agentMessage/delta", {
        threadId: "stdio-thread",
        turnId: "stdio-turn",
        itemId: "stdio-message",
        delta: "stdio output",
      });
      notify("item/completed", {
        threadId: "stdio-thread",
        turnId: "stdio-turn",
        item: { type: "agentMessage", text: "stdio final" },
      });
      notify("turn/completed", {
        threadId: "stdio-thread",
        turn: { id: "stdio-turn", status: "completed" },
      });
      process.stdout.write("tail-partial");
      setImmediate(() => process.exit(0));
    }, 10);
    return;
  }
  if (message.method === "turn/interrupt") {
    send({ jsonrpc: "2.0", id: message.id, result: {} });
  }
});

rl.on("close", () => {
  process.exit(0);
});
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("buildCodexAppServerArgs: default stdio launch uses app-server only", () => {
  assert.deepEqual(buildCodexAppServerArgs(false, []), ["app-server"]);
});

test("buildCodexAppServerArgs: unrestricted launch adds dangerous bypass flag", () => {
  assert.deepEqual(buildCodexAppServerArgs(true, ["--model", "gpt-5.4"]), [
    "--dangerously-bypass-approvals-and-sandbox",
    "app-server",
    "--model",
    "gpt-5.4",
  ]);
});

test("buildCodexThreadParams: unrestricted sets approvalPolicy and sandbox", () => {
  assert.deepEqual(
    buildCodexThreadParams({
      ...baseCtx,
      unrestricted: true,
      model: "openai/gpt-5.4",
      effort: "high",
    }),
    {
      cwd: "/repo",
      model: "gpt-5.4",
      effort: "high",
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    },
  );
});

test("buildCodexThreadParams: projects task-runner lineage env into config", () => {
  assert.deepEqual(
    buildCodexThreadParams({
      ...baseCtx,
      env: {
        TASK_RUNNER_CALL_DEPTH: "1",
        TASK_RUNNER_MAX_CALL_DEPTH: "2",
        TASK_RUNNER_PARENT_RUN_ID: "parent-run",
        TASK_RUNNER_RUN_GROUP_ID: "group-1",
        TASK_RUNNER_RUN_ID: "current-run",
        TASK_RUNNER_CWD: "/repo",
        TASK_RUNNER_CODEX_WS_URL: "ws://should-not-forward.example/socket",
        SECRET_TOKEN: "should-not-forward",
        EMPTY_LINEAGE: "",
      },
    }),
    {
      cwd: "/repo",
      config: {
        "shell_environment_policy.set.TASK_RUNNER_CALL_DEPTH": "1",
        "shell_environment_policy.set.TASK_RUNNER_MAX_CALL_DEPTH": "2",
        "shell_environment_policy.set.TASK_RUNNER_PARENT_RUN_ID": "parent-run",
        "shell_environment_policy.set.TASK_RUNNER_RUN_GROUP_ID": "group-1",
        "shell_environment_policy.set.TASK_RUNNER_RUN_ID": "current-run",
        "shell_environment_policy.set.TASK_RUNNER_CWD": "/repo",
      },
    },
  );
});

test("buildCodexThreadParams: resume preserves extra config and lets lineage win", () => {
  assert.deepEqual(
    buildCodexThreadParams(
      {
        ...baseCtx,
        env: {
          TASK_RUNNER_PARENT_RUN_ID: "current-run",
          TASK_RUNNER_RUN_GROUP_ID: "group-1",
          TASK_RUNNER_CWD: "   ",
        },
      },
      {
        threadId: "thread-123",
        config: {
          model_provider: "local",
          "shell_environment_policy.set.TASK_RUNNER_PARENT_RUN_ID": "stale-parent",
        },
      },
    ),
    {
      cwd: "/repo",
      threadId: "thread-123",
      config: {
        model_provider: "local",
        "shell_environment_policy.set.TASK_RUNNER_PARENT_RUN_ID": "current-run",
        "shell_environment_policy.set.TASK_RUNNER_RUN_GROUP_ID": "group-1",
      },
    },
  );
});

test("buildCodexTurnStartPayload: unrestricted restates danger-full-access policy", () => {
  assert.deepEqual(buildCodexTurnStartPayload("thr_123", "Write /home/kevin/out.txt", true), {
    threadId: "thr_123",
    input: [{ type: "text", text: "Write /home/kevin/out.txt" }],
    approvalPolicy: "never",
    sandboxPolicy: { type: "dangerFullAccess" },
  });
});

test("resolveCodexTransportConfig: uses the explicit stdio transport", () => {
  assert.deepEqual(
    resolveCodexTransportConfig({
      backendConfig: {
        transport: { type: "stdio" },
      },
    }),
    { type: "stdio" },
  );
});

test("resolveCodexTransportConfig: normalizes explicit websocket transport", () => {
  assert.deepEqual(
    resolveCodexTransportConfig({
      backendConfig: {
        transport: { type: "ws", url: "ws://127.0.0.1:4773" },
      },
    }),
    { type: "ws", url: "ws://127.0.0.1:4773/" },
  );
});

test("resolveCodexTransportConfig: normalizes explicit UDS transport", () => {
  assert.deepEqual(
    resolveCodexTransportConfig({
      backendConfig: {
        transport: { type: "uds", path: " /tmp/codex.sock " },
      },
    }),
    { type: "uds", path: "/tmp/codex.sock" },
  );
});

test("resolveCodexTransportConfig: rejects missing frozen transport", () => {
  assert.throws(
    () => resolveCodexTransportConfig({ backendConfig: undefined }),
    /backendConfig\.codex\.transport/,
  );
});

test("resolveCodexBackendConfig: authored config wins over override and env", () => {
  assert.deepEqual(
    resolveCodexBackendConfig({
      backendName: "codex",
      authoredConfig: {
        transport: { type: "stdio" },
      },
      overrideConfig: {
        transport: { type: "ws", url: "ws://override.example/socket" },
      },
      env: {
        TASK_RUNNER_CODEX_UDS_PATH: "/tmp/env-codex.sock",
      },
    }),
    {
      transport: { type: "stdio" },
    },
  );
});

test("resolveCodexBackendConfig: override config wins over env", () => {
  assert.deepEqual(
    resolveCodexBackendConfig({
      backendName: "codex",
      authoredConfig: undefined,
      overrideConfig: {
        transport: { type: "ws", url: "ws://override.example/socket" },
      },
      env: {
        TASK_RUNNER_CODEX_UDS_PATH: "/tmp/env-codex.sock",
      },
    }),
    {
      transport: { type: "ws", url: "ws://override.example/socket" },
    },
  );
});

test("resolveCodexBackendConfig: env transport wins over stdio default", () => {
  assert.deepEqual(
    resolveCodexBackendConfig({
      backendName: "codex",
      authoredConfig: undefined,
      overrideConfig: undefined,
      env: {
        TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773",
      },
    }),
    {
      transport: { type: "ws", url: "ws://127.0.0.1:4773/" },
    },
  );
});

test("resolveCodexBackendConfig: defaults to stdio without config or env", () => {
  assert.deepEqual(
    resolveCodexBackendConfig({
      backendName: "codex",
      authoredConfig: undefined,
      overrideConfig: undefined,
      env: {},
    }),
    {
      transport: { type: "stdio" },
    },
  );
});

test("resolveCodexBackendConfig: rejects malformed and conflicting env transports", () => {
  assert.throws(
    () =>
      resolveCodexBackendConfig({
        backendName: "codex",
        authoredConfig: undefined,
        overrideConfig: undefined,
        env: {
          TASK_RUNNER_CODEX_WS_URL: "https://example.com/socket",
        },
      }),
    /codex websocket transport requires an absolute ws:\/\/ or wss:\/\/ URL/,
  );
  assert.throws(
    () =>
      resolveCodexBackendConfig({
        backendName: "codex",
        authoredConfig: undefined,
        overrideConfig: undefined,
        env: {
          TASK_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock",
          TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
        },
      }),
    /TASK_RUNNER_CODEX_UDS_PATH and TASK_RUNNER_CODEX_WS_URL cannot both be set/,
  );
});

test("normalizeCodexUdsPath: rejects malformed socket paths before transport open", () => {
  assert.throws(() => normalizeCodexUdsPath("relative/socket"), /absolute socket path/);
  assert.throws(() => normalizeCodexUdsPath("~/codex.sock"), /absolute socket path/);
  assert.throws(() => normalizeCodexUdsPath("unix:///tmp/codex.sock"), /absolute socket path/);
});

test("normalizeCodexWsUrl: rejects malformed or non-websocket URLs before transport open", () => {
  assert.throws(() => normalizeCodexWsUrl("relative/socket"), /absolute ws:\/\/ or wss:\/\/ URL/);
  assert.throws(
    () => normalizeCodexWsUrl("https://example.com/socket"),
    /absolute ws:\/\/ or wss:\/\/ URL/,
  );
});

async function startCodexTurnNoiseServer({
  childThreadId = "child-thread",
  childBeforeTurnStartResult = false,
} = {}) {
  const server = new WebSocketServer({ port: 0 });
  const parentThreadId = "parent-thread";
  const parentTurnId = "parent-turn";
  const childTurnId = "child-turn";

  server.on("connection", (socket) => {
    const notify = (method, params) => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    };

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return;
      }
      if (message.method === "initialized") {
        return;
      }
      if (message.method === "thread/start") {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { thread: { id: parentThreadId } },
          }),
        );
        return;
      }
      if (message.method === "turn/start") {
        const sendChildNotifications = () => {
          if (childThreadId !== parentThreadId) {
            notify("thread/started", {
              thread: { id: childThreadId },
            });
          }
          notify("turn/started", {
            threadId: childThreadId,
            turn: { id: childTurnId, status: "inProgress" },
          });
          notify("item/agentMessage/delta", {
            threadId: childThreadId,
            turnId: childTurnId,
            itemId: "child-message",
            delta: "child output",
          });
          notify("item/completed", {
            threadId: childThreadId,
            turnId: childTurnId,
            item: { type: "agentMessage", text: "child final" },
          });
          notify("turn/completed", {
            threadId: childThreadId,
            turn: { id: childTurnId, status: "completed" },
          });
        };
        const sendParentNotifications = () => {
          notify("item/agentMessage/delta", {
            threadId: parentThreadId,
            turnId: parentTurnId,
            itemId: "parent-message",
            delta: "parent output",
          });
          notify("item/completed", {
            threadId: parentThreadId,
            turnId: parentTurnId,
            item: { type: "agentMessage", text: "parent final" },
          });
          notify("turn/completed", {
            threadId: parentThreadId,
            turn: { id: parentTurnId, status: "completed" },
          });
        };

        if (childBeforeTurnStartResult) sendChildNotifications();
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { turn: { id: parentTurnId } },
          }),
        );

        if (!childBeforeTurnStartResult) sendChildNotifications();
        setTimeout(sendParentNotifications, 25);
      }
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind codex turn noise test server");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function invokeCodexTurnNoiseServer(codexServer) {
  const emitted = [];

  try {
    const result = await codexBackend.invoke({
      ...baseCtx,
      backendConfig: {
        transport: { type: "ws", url: codexServer.url },
      },
      emit: (event) => emitted.push(event),
    });

    assert.equal(result.exitCode, 0, `${result.rawStderr}\n${result.rawStdout}`);
    assert.equal(result.sessionId, "parent-thread");
    assert.match(result.transcript, /parent output/);
    assert.match(result.transcript, /parent final/);
    assert.doesNotMatch(result.transcript, /child/);
    assert.equal(
      emitted
        .filter((event) => event.type === "agent_message_delta")
        .map((event) => event.text)
        .join(""),
      "parent output",
    );
  } finally {
    await codexServer.close();
  }
}

async function startMalformedJsonCodexServer() {
  const server = new WebSocketServer({ port: 0 });

  server.on("connection", (socket) => {
    socket.on("message", () => {
      socket.send("{not-json");
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind malformed JSON Codex test server");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/`,
    async close() {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function startCodexThreadStartCaptureServer() {
  const server = new WebSocketServer({ port: 0 });
  const capturedThreadStartParams = [];
  const threadId = "captured-thread";
  const turnId = "captured-turn";

  server.on("connection", (socket) => {
    const notify = (method, params) => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    };

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return;
      }
      if (message.method === "initialized") {
        return;
      }
      if (message.method === "thread/start") {
        capturedThreadStartParams.push(message.params);
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { thread: { id: threadId } },
          }),
        );
        return;
      }
      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { turn: { id: turnId } },
          }),
        );
        setTimeout(() => {
          notify("item/agentMessage/delta", {
            threadId,
            turnId,
            itemId: "captured-message",
            delta: "captured output",
          });
          notify("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed" },
          });
        }, 10);
      }
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind Codex thread/start capture test server");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/`,
    capturedThreadStartParams,
    async close() {
      for (const client of server.clients) {
        client.terminate();
      }
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
    },
  };
}

async function startCodexUdsServer(socketName = "codex.sock") {
  const dir = mkdtempSync(join(tmpdir(), "task-runner-codex-uds-"));
  const socketPath = join(dir, socketName);
  const server = createServer();
  const wsServer = new WebSocketServer({ server });
  const threadId = "uds-thread";
  const turnId = "uds-turn";

  wsServer.on("connection", (socket) => {
    const notify = (method, params) => {
      socket.send(JSON.stringify({ jsonrpc: "2.0", method, params }));
    };

    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      if (message.method === "initialize") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
        return;
      }
      if (message.method === "initialized") {
        return;
      }
      if (message.method === "thread/start") {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { thread: { id: threadId } },
          }),
        );
        return;
      }
      if (message.method === "turn/start") {
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { turn: { id: turnId } },
          }),
        );
        setTimeout(() => {
          notify("item/agentMessage/delta", {
            threadId,
            turnId,
            itemId: "uds-message",
            delta: "UDS output",
          });
          notify("item/completed", {
            threadId,
            turnId,
            item: { type: "agentMessage", text: "UDS final" },
          });
          notify("turn/completed", {
            threadId,
            turn: { id: turnId, status: "completed" },
          });
        }, 25);
        return;
      }
      if (message.method === "turn/interrupt") {
        socket.send(JSON.stringify({ jsonrpc: "2.0", id: message.id, result: {} }));
      }
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return {
    path: socketPath,
    async close() {
      for (const client of wsServer.clients) {
        client.terminate();
      }
      await new Promise((resolve, reject) => {
        wsServer.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      await new Promise((resolve, reject) => {
        server.close((err) => {
          if (err) reject(err);
          else resolve();
        });
      });
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

test("codexBackend ignores child thread turn completion while waiting for the parent turn", async () => {
  await invokeCodexTurnNoiseServer(await startCodexTurnNoiseServer());
});

test("codexBackend ignores same-thread child turn notifications before parent turn id resolves", async () => {
  await invokeCodexTurnNoiseServer(
    await startCodexTurnNoiseServer({
      childThreadId: "parent-thread",
      childBeforeTurnStartResult: true,
    }),
  );
});

test("codexBackend rejects pending calls when a transport frame is malformed JSON", async () => {
  const codexServer = await startMalformedJsonCodexServer();

  try {
    const result = await codexBackend.invoke({
      ...baseCtx,
      backendConfig: {
        transport: { type: "ws", url: codexServer.url },
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.sessionId, null);
    assert.match(result.rawStderr, /malformed JSON-RPC/);
    assert.match(result.rawStderr, /Unexpected token|Expected property name/);
  } finally {
    await codexServer.close();
  }
});

test("codexBackend sends lineage config over websocket thread/start", async () => {
  const codexServer = await startCodexThreadStartCaptureServer();

  try {
    const result = await codexBackend.invoke({
      ...baseCtx,
      env: {
        TASK_RUNNER_CALL_DEPTH: "1",
        TASK_RUNNER_MAX_CALL_DEPTH: "2",
        TASK_RUNNER_PARENT_RUN_ID: "parent-run",
        TASK_RUNNER_RUN_GROUP_ID: "group-1",
        TASK_RUNNER_RUN_ID: "current-run",
        TASK_RUNNER_CWD: "/repo",
        TASK_RUNNER_CODEX_WS_URL: "ws://should-not-forward.example/socket",
        SECRET_TOKEN: "should-not-forward",
      },
      backendConfig: {
        transport: { type: "ws", url: codexServer.url },
      },
    });

    assert.equal(result.exitCode, 0, `${result.rawStderr}\n${result.rawStdout}`);
    assert.equal(codexServer.capturedThreadStartParams.length, 1);
    assert.deepEqual(codexServer.capturedThreadStartParams[0], {
      cwd: "/repo",
      config: {
        "shell_environment_policy.set.TASK_RUNNER_CALL_DEPTH": "1",
        "shell_environment_policy.set.TASK_RUNNER_MAX_CALL_DEPTH": "2",
        "shell_environment_policy.set.TASK_RUNNER_PARENT_RUN_ID": "parent-run",
        "shell_environment_policy.set.TASK_RUNNER_RUN_GROUP_ID": "group-1",
        "shell_environment_policy.set.TASK_RUNNER_RUN_ID": "current-run",
        "shell_environment_policy.set.TASK_RUNNER_CWD": "/repo",
      },
    });
  } finally {
    await codexServer.close();
  }
});

test("codexBackend captures raw stdio stdout without outgoing frames or prefixes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-runner-codex-stdio-"));
  const command = writeFakeCodexBin(dir);
  const rawStdoutLines = [];

  try {
    const result = await withEnv({ TASK_RUNNER_CODEX_BIN: command }, () =>
      codexBackend.invoke({
        ...baseCtx,
        cwd: dir,
        env: {
          ...process.env,
          CODEX_TEST_MODE: "normal",
        },
        backendConfig: {
          transport: { type: "stdio" },
        },
        onRawStdoutLine: (line) => rawStdoutLines.push(line),
      }),
    );

    assert.equal(result.exitCode, 0, `${result.rawStderr}\n${result.rawStdout}`);
    assert.equal(result.sessionId, "stdio-thread");
    assert.match(result.transcript, /stdio output/);
    assert.match(result.transcript, /stdio final/);
    assert.equal(rawStdoutLines[0], "\n");
    assert.equal(rawStdoutLines[1], "   \n");
    assert.equal(rawStdoutLines.at(-1), "tail-partial");
    const captured = rawStdoutLines.join("");
    assert.match(captured, /"thread":\{"id":"stdio-thread"\}/);
    assert.doesNotMatch(captured, /^> /m);
    assert.doesNotMatch(captured, /^< /m);
    assert.doesNotMatch(captured, /"method":"initialize"/);
    assert.doesNotMatch(captured, /"method":"thread\/start"/);
    assert.doesNotMatch(captured, /"method":"turn\/start"/);
    assert.doesNotMatch(captured, /ignored/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codexBackend captures raw stdio stdout on JSON-RPC parse errors", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-runner-codex-stdio-malformed-"));
  const command = writeFakeCodexBin(dir);
  const rawStdoutLines = [];

  try {
    const result = await withEnv({ TASK_RUNNER_CODEX_BIN: command }, () =>
      codexBackend.invoke({
        ...baseCtx,
        cwd: dir,
        env: {
          ...process.env,
          CODEX_TEST_MODE: "malformed",
        },
        backendConfig: {
          transport: { type: "stdio" },
        },
        onRawStdoutLine: (line) => rawStdoutLines.push(line),
      }),
    );

    assert.equal(result.exitCode, 1);
    assert.match(result.rawStderr, /malformed JSON-RPC/);
    assert.deepEqual(rawStdoutLines, [
      "{not-json\n",
      "raw-after-malformed\n",
      "tail-after-malformed",
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("codexBackend invokes Codex over a Unix domain socket WebSocket transport", async () => {
  const codexServer = await startCodexUdsServer("codex socket:1.sock");
  const emitted = [];

  try {
    const result = await codexBackend.invoke({
      ...baseCtx,
      backendConfig: {
        transport: { type: "uds", path: codexServer.path },
      },
      emit: (event) => emitted.push(event),
    });

    assert.equal(result.exitCode, 0, `${result.rawStderr}\n${result.rawStdout}`);
    assert.equal(result.sessionId, "uds-thread");
    assert.match(result.transcript, /UDS output/);
    assert.match(result.transcript, /UDS final/);
    assert.equal(
      emitted
        .filter((event) => event.type === "agent_message_delta")
        .map((event) => event.text)
        .join(""),
      "UDS output",
    );
  } finally {
    await codexServer.close();
  }
});

test("codexBackend surfaces UDS connection failures clearly", async () => {
  const dir = mkdtempSync(join(tmpdir(), "task-runner-codex-missing-uds-"));
  const socketPath = join(dir, "missing.sock");

  try {
    const result = await codexBackend.invoke({
      ...baseCtx,
      backendConfig: {
        transport: { type: "uds", path: socketPath },
      },
    });

    assert.equal(result.exitCode, 1);
    assert.equal(result.sessionId, null);
    assert.match(result.rawStderr, /connect|ENOENT/);
    assert.match(result.rawStderr, /missing\.sock/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
