import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { WebSocketServer } from "ws";
import { DaemonClient } from "../apps/cli/dist/daemon/client.js";
import { serveDaemon } from "../apps/cli/dist/daemon/server.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { readRunAuditHistory } from "../packages/core/dist/core/run/run-events.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { withTaskStateLock } from "../packages/core/dist/core/run/workspace-state.js";
import { freePort } from "./helpers/daemon-process.mjs";
import { sharedRuntimeEnv, withEnv } from "./helpers/runtime-paths.mjs";

const ASSIGNMENT = `---
schemaVersion: 1
name: recovery-work
tasks:
  - id: t1
    title: Recover
---
Recovery assignment.
`;

const CODEX_THREAD_STATUS = {
  active: { type: "active", activeFlags: [] },
  idle: { type: "idle" },
  systemError: { type: "systemError" },
  notLoaded: { type: "notLoaded" },
};

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-daemon-recovery-"));
}

function writeAgent(baseDir, name, backend) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "agent.md"),
    `---
schemaVersion: 1
name: ${name}
backend: ${backend}
---
Recovery agent.
`,
  );
}

function writeAssignment(baseDir) {
  const path = join(baseDir, "assignments", "recovery-work", "assignment.md");
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, ASSIGNMENT);
}

async function initRun(baseDir, agentName) {
  return withEnv(sharedRuntimeEnv(baseDir), async () => {
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      const loaded = loadAgentConfig(agentName, baseDir);
      return await runAgent({
        loaded,
        loadedAssignment: loadAssignmentConfig("recovery-work", baseDir),
        cliVars: {},
        webVars: {},
        parentRunId: null,
        backend: {
          id: loaded.config.backend,
          async invoke() {
            throw new Error("backend should not be invoked during init");
          },
        },
        initialize: true,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function patchManifest(workspaceDir, mutator) {
  withTaskStateLock(workspaceDir, () => {
    const manifest = readManifest(workspaceDir);
    mutator(manifest);
    writeFileSync(join(workspaceDir, "run.json"), `${JSON.stringify(manifest, null, 2)}\n`);
  });
}

function markRunning(workspaceDir, patch = {}) {
  patchManifest(workspaceDir, (manifest) => {
    manifest.status = "running";
    manifest.exitCode = null;
    manifest.endedAt = null;
    manifest.totalAttemptCount = Math.max(manifest.totalAttemptCount, 1);
    manifest.totalSessionCount = Math.max(manifest.totalSessionCount, 1);
    manifest.execution = {
      hostMode: "daemon",
      controller: { kind: "daemon", daemonInstanceId: "previous-daemon" },
    };
    Object.assign(manifest, patch);
  });
}

function auditEvents(workspaceDir, runId) {
  return readRunAuditHistory({ workspaceDir, runId }).events.map((entry) => entry.event);
}

function unusedPidCandidate() {
  for (let pid = 999_999; pid < 1_100_000; pid++) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if (error.code === "ESRCH") {
        return pid;
      }
    }
  }
  throw new Error("failed to find unused pid candidate");
}

function startLivePidProcess() {
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000);"], {
    stdio: "ignore",
  });
  if (!child.pid) {
    throw new Error("failed to start live pid process");
  }
  process.kill(child.pid, 0);
  return child;
}

async function stopLivePidProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  child.kill("SIGTERM");
  await new Promise((resolve) => {
    child.once("exit", resolve);
  });
}

async function waitFor(condition, message, timeoutMs = 3_000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const value = condition();
    if (value) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(message);
}

async function startCodexThreadStatusServer({
  status,
  completeResume = false,
  respondToRead = true,
}) {
  const server = new WebSocketServer({ port: 0 });
  const calls = [];
  const waiters = new Map();

  const markCall = (method) => {
    for (const resolve of waiters.get(method) ?? []) {
      resolve();
    }
    waiters.delete(method);
  };

  server.on("connection", (socket) => {
    const send = (message) => socket.send(JSON.stringify(message));
    const notify = (method, params) => send({ jsonrpc: "2.0", method, params });
    socket.on("message", (data) => {
      const message = JSON.parse(data.toString("utf8"));
      calls.push(message);
      markCall(message.method);
      if (message.method === "initialize") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        return;
      }
      if (message.method === "initialized") return;
      if (message.method === "thread/read") {
        if (!respondToRead) {
          return;
        }
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: {
            thread: {
              id: message.params.threadId,
              cwd: "/repo",
              status,
            },
          },
        });
        return;
      }
      if (message.method === "thread/resume") {
        send({
          jsonrpc: "2.0",
          id: message.id,
          result: { thread: { id: message.params.threadId } },
        });
        setTimeout(() => {
          notify("turn/started", {
            threadId: message.params.threadId,
            turn: { id: "turn-recovered", status: "inProgress" },
          });
          if (completeResume) {
            notify("turn/completed", {
              threadId: message.params.threadId,
              turn: { id: "turn-recovered", status: "completed" },
            });
          }
        }, 10);
        return;
      }
      if (message.method === "turn/interrupt") {
        send({ jsonrpc: "2.0", id: message.id, result: {} });
        notify("turn/completed", {
          threadId: message.params.threadId,
          turn: { id: message.params.turnId, status: "interrupted" },
        });
      }
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("failed to bind Codex status test server");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/`,
    calls,
    waitForMethod(method) {
      if (calls.some((call) => call.method === method)) return Promise.resolve();
      return new Promise((resolve) => {
        const entries = waiters.get(method) ?? [];
        entries.push(resolve);
        waiters.set(method, entries);
      });
    },
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

test("daemon startup skips running runs owned by a different live daemon pid", async () => {
  const dir = tempDir();
  const liveOwner = startLivePidProcess();
  writeAgent(dir, "local-agent", "claude");
  writeAssignment(dir);
  const run = await initRun(dir, "local-agent");
  const ownerId = `daemon-${liveOwner.pid}-owner`;
  markRunning(run.workspaceDir, {
    execution: {
      hostMode: "daemon",
      controller: { kind: "daemon", daemonInstanceId: ownerId },
    },
  });
  const before = readManifest(run.workspaceDir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = readManifest(run.workspaceDir);
        assert.deepEqual(manifest, before);
        const events = auditEvents(run.workspaceDir, run.runId);
        assert.equal(
          events.find((event) => event.type === "run.controller_reconciled")?.fields.decision,
          "skipped_live_owner",
        );
        assert.equal(
          events.some((event) => event.type === "run.finished"),
          false,
        );
      } finally {
        await server.close();
      }
    });
  } finally {
    await stopLivePidProcess(liveOwner);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup reconciles running runs owned by the current pid with a different daemon id", async () => {
  const dir = tempDir();
  writeAgent(dir, "local-agent", "claude");
  writeAssignment(dir);
  const run = await initRun(dir, "local-agent");
  markRunning(run.workspaceDir, {
    execution: {
      hostMode: "daemon",
      controller: { kind: "daemon", daemonInstanceId: `daemon-${process.pid}-owner` },
    },
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = readManifest(run.workspaceDir);
        assert.equal(manifest.status, "error");
        assert.equal(manifest.exitCode, 4);
        const events = auditEvents(run.workspaceDir, run.runId);
        assert.equal(
          events.find((event) => event.type === "run.controller_reconciled")?.fields.reason,
          "stale_local_controller",
        );
        assert.equal(
          events.some((event) => event.type === "run.finished"),
          true,
        );
      } finally {
        await server.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup skips Codex websocket runs owned by a different live daemon pid", async () => {
  const dir = tempDir();
  const liveOwner = startLivePidProcess();
  writeAgent(dir, "codex-agent", "codex");
  writeAssignment(dir);
  const codexServer = await startCodexThreadStatusServer({
    status: CODEX_THREAD_STATUS.active,
  });
  const run = await initRun(dir, "codex-agent");
  markRunning(run.workspaceDir, {
    backendSessionId: "thread-active",
    backendConfig: { transport: { type: "ws", url: codexServer.url } },
    cwd: "/repo",
    execution: {
      hostMode: "daemon",
      controller: { kind: "daemon", daemonInstanceId: `daemon-${liveOwner.pid}-owner` },
    },
  });
  const before = readManifest(run.workspaceDir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = readManifest(run.workspaceDir);
        assert.deepEqual(manifest, before);
        assert.equal(
          codexServer.calls.some((call) => call.method === "thread/read"),
          false,
        );
        const events = auditEvents(run.workspaceDir, run.runId);
        assert.equal(
          events.find((event) => event.type === "run.controller_reconciled")?.fields.decision,
          "skipped_live_owner",
        );
        assert.equal(
          events.some((event) => event.type === "run.finished"),
          false,
        );
      } finally {
        await server.close();
      }
    });
  } finally {
    await stopLivePidProcess(liveOwner);
    await codexServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup marks stale local running runs as error", async () => {
  const dir = tempDir();
  writeAgent(dir, "local-agent", "claude");
  writeAssignment(dir);
  const run = await initRun(dir, "local-agent");
  markRunning(run.workspaceDir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = readManifest(run.workspaceDir);
        assert.equal(manifest.status, "error");
        assert.equal(manifest.exitCode, 4);
        const events = auditEvents(run.workspaceDir, run.runId);
        assert.equal(
          events.find((event) => event.type === "run.controller_reconciled")?.fields.reason,
          "stale_local_controller",
        );
        assert.equal(
          events.some((event) => event.type === "run.finished"),
          true,
        );
      } finally {
        await server.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup reconciles running runs owned by a dead daemon pid", async () => {
  const dir = tempDir();
  writeAgent(dir, "local-agent", "claude");
  writeAssignment(dir);
  const run = await initRun(dir, "local-agent");
  const deadPid = unusedPidCandidate();
  markRunning(run.workspaceDir, {
    execution: {
      hostMode: "daemon",
      controller: { kind: "daemon", daemonInstanceId: `daemon-${deadPid}-owner` },
    },
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = readManifest(run.workspaceDir);
        assert.equal(manifest.status, "error");
        assert.equal(manifest.exitCode, 4);
        const events = auditEvents(run.workspaceDir, run.runId);
        assert.equal(
          events.find((event) => event.type === "run.controller_reconciled")?.fields.reason,
          "stale_local_controller",
        );
      } finally {
        await server.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup adopts active Codex websocket runs and graceful close detaches", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", "codex");
  writeAssignment(dir);
  const codexServer = await startCodexThreadStatusServer({
    status: CODEX_THREAD_STATUS.active,
  });
  const run = await initRun(dir, "codex-agent");
  markRunning(run.workspaceDir, {
    backendSessionId: "thread-active",
    backendConfig: { transport: { type: "ws", url: codexServer.url } },
    cwd: "/repo",
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        await codexServer.waitForMethod("thread/resume");
        const detail = await client.call("runs.get", { target: run.runId });
        assert.equal(detail.run.status, "running");
        assert.equal(detail.run.isLive, true);
        assert.equal(detail.run.capabilities.canAbort, true);

        await server.close();
        const manifest = readManifest(run.workspaceDir);
        assert.equal(manifest.status, "running");
        assert.equal(
          codexServer.calls.some((call) => call.method === "turn/start"),
          false,
        );
        assert.equal(
          codexServer.calls.some((call) => call.method === "turn/interrupt"),
          false,
        );
        const events = auditEvents(run.workspaceDir, run.runId);
        assert.equal(
          events.find((event) => event.type === "run.controller_reconciled")?.fields.decision,
          "adopted_active",
        );
        assert.equal(
          events.find((event) => event.type === "run.controller_detached")?.fields.reason,
          "daemon_shutdown",
        );
      } finally {
        await client.close().catch(() => undefined);
      }
    });
  } finally {
    await codexServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup finalizes completed adopted Codex websocket runs", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", "codex");
  writeAssignment(dir);
  const codexServer = await startCodexThreadStatusServer({
    status: CODEX_THREAD_STATUS.active,
    completeResume: true,
  });
  const run = await initRun(dir, "codex-agent");
  markRunning(run.workspaceDir, {
    backendSessionId: "thread-completes",
    backendConfig: { transport: { type: "ws", url: codexServer.url } },
    cwd: "/repo",
  });
  patchManifest(run.workspaceDir, (manifest) => {
    manifest.finalTasks.t1.status = "completed";
    manifest.tasksCompleted = 1;
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = await waitFor(() => {
          const candidate = readManifest(run.workspaceDir);
          return candidate.status === "success" ? candidate : null;
        }, "completed adopted Codex run was not finalized");
        assert.equal(manifest.exitCode, 0);
        assert.equal(
          codexServer.calls.some((call) => call.method === "turn/start"),
          false,
        );
        const reconciled = auditEvents(run.workspaceDir, run.runId)
          .filter((event) => event.type === "run.controller_reconciled")
          .at(-1);
        assert.equal(reconciled?.fields.decision, "finalized_idle");
        assert.equal(reconciled?.fields.reason, "completed_after_recovery");
      } finally {
        await server.close();
      }
    });
  } finally {
    await codexServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon aborts startup-adopted Codex websocket runs with turn interrupt", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", "codex");
  writeAssignment(dir);
  const codexServer = await startCodexThreadStatusServer({
    status: CODEX_THREAD_STATUS.active,
  });
  const run = await initRun(dir, "codex-agent");
  markRunning(run.workspaceDir, {
    backendSessionId: "thread-abort",
    backendConfig: { transport: { type: "ws", url: codexServer.url } },
    cwd: "/repo",
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      const client = await DaemonClient.connect(listenUrl);
      try {
        await codexServer.waitForMethod("thread/resume");
        await new Promise((resolve) => setTimeout(resolve, 30));
        await client.call("runs.abort", { target: run.runId });
        const manifest = await waitFor(() => {
          const candidate = readManifest(run.workspaceDir);
          return candidate.status === "aborted" ? candidate : null;
        }, "startup-adopted Codex run was not aborted");
        assert.equal(manifest.exitCode, 130);
        assert.equal(
          codexServer.calls.some((call) => call.method === "turn/interrupt"),
          true,
        );
        const reconciled = auditEvents(run.workspaceDir, run.runId)
          .filter((event) => event.type === "run.controller_reconciled")
          .at(-1);
        assert.equal(reconciled?.fields.decision, "adopted_aborted");
        assert.equal(reconciled?.fields.reason, "aborted_after_recovery");
      } finally {
        await client.close().catch(() => undefined);
        await server.close();
      }
    });
  } finally {
    await codexServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

for (const [remoteStatus, status, expectedReason] of [
  ["Idle", CODEX_THREAD_STATUS.idle, "insufficient_idle_evidence"],
  ["SystemError", CODEX_THREAD_STATUS.systemError, "remote_system_error"],
  ["NotLoaded", CODEX_THREAD_STATUS.notLoaded, "remote_not_loaded"],
]) {
  test(`daemon startup marks Codex ${remoteStatus} running runs as error`, async () => {
    const dir = tempDir();
    writeAgent(dir, "codex-agent", "codex");
    writeAssignment(dir);
    const codexServer = await startCodexThreadStatusServer({ status });
    const run = await initRun(dir, "codex-agent");
    markRunning(run.workspaceDir, {
      backendSessionId: `thread-${remoteStatus}`,
      backendConfig: { transport: { type: "ws", url: codexServer.url } },
      cwd: "/repo",
    });
    const port = await freePort();
    const listenUrl = `ws://127.0.0.1:${port}/`;

    try {
      await withEnv(sharedRuntimeEnv(dir), async () => {
        const server = await serveDaemon(listenUrl);
        try {
          const manifest = readManifest(run.workspaceDir);
          assert.equal(manifest.status, "error");
          assert.equal(manifest.exitCode, 4);
          const reconciled = auditEvents(run.workspaceDir, run.runId).find(
            (event) => event.type === "run.controller_reconciled",
          );
          assert.equal(reconciled?.fields.remoteStatus, remoteStatus);
          assert.equal(reconciled?.fields.reason, expectedReason);
        } finally {
          await server.close();
        }
      });
    } finally {
      await codexServer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test("daemon startup marks malformed Codex thread/read responses as thread_read_failed", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", "codex");
  writeAssignment(dir);
  const codexServer = await startCodexThreadStatusServer({ status: "UnexpectedStatus" });
  const run = await initRun(dir, "codex-agent");
  markRunning(run.workspaceDir, {
    backendSessionId: "thread-bad-status",
    backendConfig: { transport: { type: "ws", url: codexServer.url } },
    cwd: "/repo",
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = readManifest(run.workspaceDir);
        assert.equal(manifest.status, "error");
        assert.equal(manifest.exitCode, 4);
        const reconciled = auditEvents(run.workspaceDir, run.runId).find(
          (event) => event.type === "run.controller_reconciled",
        );
        assert.equal(reconciled?.fields.reason, "thread_read_failed");
      } finally {
        await server.close();
      }
    });
  } finally {
    await codexServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup times out Codex thread/read that never replies", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", "codex");
  writeAssignment(dir);
  const codexServer = await startCodexThreadStatusServer({
    status: CODEX_THREAD_STATUS.active,
    respondToRead: false,
  });
  const run = await initRun(dir, "codex-agent");
  markRunning(run.workspaceDir, {
    backendSessionId: "thread-hung-read",
    backendConfig: { transport: { type: "ws", url: codexServer.url } },
    cwd: "/repo",
    timeoutSec: 0.01,
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = readManifest(run.workspaceDir);
        assert.equal(manifest.status, "error");
        assert.equal(manifest.exitCode, 4);
        const reconciled = auditEvents(run.workspaceDir, run.runId).find(
          (event) => event.type === "run.controller_reconciled",
        );
        assert.equal(reconciled?.fields.reason, "remote_unreachable");
        assert.match(reconciled?.fields.error, /timed out/);
      } finally {
        await server.close();
      }
    });
  } finally {
    await codexServer.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("daemon startup marks unreachable Codex websocket runs as error", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", "codex");
  writeAssignment(dir);
  const codexPort = await freePort();
  const run = await initRun(dir, "codex-agent");
  markRunning(run.workspaceDir, {
    backendSessionId: "thread-unreachable",
    backendConfig: { transport: { type: "ws", url: `ws://127.0.0.1:${codexPort}/` } },
    cwd: "/repo",
  });
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  try {
    await withEnv(sharedRuntimeEnv(dir), async () => {
      const server = await serveDaemon(listenUrl);
      try {
        const manifest = await waitFor(() => {
          const candidate = readManifest(run.workspaceDir);
          return candidate.status === "error" ? candidate : null;
        }, "unreachable Codex run was not reconciled to error");
        assert.equal(manifest.exitCode, 4);
        const reconciled = auditEvents(run.workspaceDir, run.runId).find(
          (event) => event.type === "run.controller_reconciled",
        );
        assert.equal(reconciled?.fields.reason, "remote_unreachable");
      } finally {
        await server.close();
      }
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
