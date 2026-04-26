import assert from "node:assert/strict";
import test from "node:test";
import { WebSocketServer } from "ws";
import {
  buildCodexAppServerArgs,
  buildCodexThreadParams,
  buildCodexTurnStartPayload,
  codexBackend,
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

test("resolveCodexTransportConfig: rejects missing frozen transport", () => {
  assert.throws(
    () => resolveCodexTransportConfig({ backendSpecific: undefined }),
    /backendSpecific\.codex\.transport/,
  );
});

test("normalizeCodexWsUrl: rejects malformed or non-websocket URLs before transport open", () => {
  assert.throws(() => normalizeCodexWsUrl("relative/socket"), /absolute ws:\/\/ or wss:\/\/ URL/);
  assert.throws(
    () => normalizeCodexWsUrl("https://example.com/socket"),
    /absolute ws:\/\/ or wss:\/\/ URL/,
  );
});

async function startCodexTurnNoiseServer() {
  const server = new WebSocketServer({ port: 0 });
  const parentThreadId = "parent-thread";
  const parentTurnId = "parent-turn";
  const childThreadId = "child-thread";
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
        socket.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: message.id,
            result: { turn: { id: parentTurnId } },
          }),
        );

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

        setTimeout(() => {
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
        }, 25);
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

test("codexBackend ignores child thread turn completion while waiting for the parent turn", async () => {
  const codexServer = await startCodexTurnNoiseServer();
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

    assert.equal(result.exitCode, 0);
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
});
