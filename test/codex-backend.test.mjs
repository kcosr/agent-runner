import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
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
  resolveCodexTransportConfig,
} from "../packages/core/dist/backends/codex.js";

const baseCtx = {
  cwd: "/repo",
  env: {},
  prompt: "ignored",
  timeoutSec: 60,
};

test("buildCodexAppServerArgs: default stdio launch uses app-server only", () => {
  assert.deepEqual(buildCodexAppServerArgs(false), ["app-server"]);
});

test("buildCodexAppServerArgs: unrestricted launch adds dangerous bypass flag", () => {
  assert.deepEqual(buildCodexAppServerArgs(true), [
    "--dangerously-bypass-approvals-and-sandbox",
    "app-server",
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
      backendSpecific: {
        codex: {
          transport: { type: "stdio" },
        },
      },
    }),
    { type: "stdio" },
  );
});

test("resolveCodexTransportConfig: normalizes explicit websocket transport", () => {
  assert.deepEqual(
    resolveCodexTransportConfig({
      backendSpecific: {
        codex: {
          transport: { type: "ws", url: "ws://127.0.0.1:4773" },
        },
      },
    }),
    { type: "ws", url: "ws://127.0.0.1:4773/" },
  );
});

test("resolveCodexTransportConfig: normalizes explicit UDS transport", () => {
  assert.deepEqual(
    resolveCodexTransportConfig({
      backendSpecific: {
        codex: {
          transport: { type: "uds", path: " /tmp/codex.sock " },
        },
      },
    }),
    { type: "uds", path: "/tmp/codex.sock" },
  );
});

test("resolveCodexTransportConfig: rejects missing frozen transport", () => {
  assert.throws(
    () => resolveCodexTransportConfig({ backendSpecific: undefined }),
    /backendSpecific\.codex\.transport/,
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
      backendSpecific: {
        codex: {
          transport: { type: "ws", url: codexServer.url },
        },
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

test("codexBackend invokes Codex over a Unix domain socket WebSocket transport", async () => {
  const codexServer = await startCodexUdsServer("codex socket:1.sock");
  const emitted = [];

  try {
    const result = await codexBackend.invoke({
      ...baseCtx,
      backendSpecific: {
        codex: {
          transport: { type: "uds", path: codexServer.path },
        },
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
      backendSpecific: {
        codex: {
          transport: { type: "uds", path: socketPath },
        },
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
