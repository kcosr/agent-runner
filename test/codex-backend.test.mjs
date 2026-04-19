import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexAppServerArgs,
  buildCodexThreadParams,
  buildCodexTurnStartPayload,
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
    /requires a ws:\/\/ or wss:\/\/ URL/,
  );
});
