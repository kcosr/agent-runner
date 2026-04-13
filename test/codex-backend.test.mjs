import assert from "node:assert/strict";
import test from "node:test";
import {
  buildCodexAppServerArgs,
  buildCodexThreadParams,
  buildCodexTurnStartPayload,
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
