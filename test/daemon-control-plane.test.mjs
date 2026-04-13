import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import WebSocket from "ws";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { runAgent } from "../dist/core/run/run-loop.js";
import { DaemonClient } from "../dist/daemon/client.js";
import { serveDaemon } from "../dist/daemon/server.js";
import { sharedRuntimeEnv, withEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: daemon-agent
backend: claude
model: claude-sonnet-4-6
---
Daemon agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: daemon-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Daemon assignment.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-daemon-"));
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "agent.md"), body);
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "assignment.md"), body);
}

async function initRun(baseDir) {
  return withEnv(sharedRuntimeEnv(baseDir), async () => {
    const loaded = loadAgentConfig("daemon-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("daemon-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: {
          id: "mock",
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

async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to allocate a test port"));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

async function openRawWebSocket(listenUrl) {
  const ws = new WebSocket(listenUrl);
  await new Promise((resolve, reject) => {
    ws.once("open", resolve);
    ws.once("error", reject);
  });
  return ws;
}

async function nextRawMessage(ws) {
  return await new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    ws.once("error", reject);
  });
}

function runCli(args, opts = {}) {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()), ...(opts.env ?? {}) },
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCliExpectFail(args, opts = {}) {
  try {
    runCli(args, opts);
    throw new Error("expected CLI to fail");
  } catch (err) {
    if (err.status === undefined) throw err;
    return {
      status: err.status,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

async function startCliDaemon(baseDir, listenUrl) {
  const child = spawn("node", [CLI_PATH, "serve", "--listen", listenUrl], {
    cwd: baseDir,
    env: { ...process.env, ...sharedRuntimeEnv(baseDir) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  await new Promise((resolve, reject) => {
    const onExit = (code, signal) =>
      reject(new Error(`daemon exited before ready (code=${code} signal=${signal})`));
    child.once("exit", onExit);
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes("serving on")) {
        child.off("exit", onExit);
        resolve();
      }
    });
  });

  return {
    child,
    async stop() {
      child.kill("SIGINT");
      await new Promise((resolve) => child.once("exit", resolve));
    },
  };
}

test("daemon rpc mirrors shared run and definition DTOs", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    const client = await DaemonClient.connect(listenUrl);
    try {
      const info = await client.call("daemon.info");
      assert.equal(info.listenUrl, listenUrl);

      const runs = await client.call("runs.list", {});
      assert.equal(runs.runs[0].runId, init.runId);

      const detail = await client.call("runs.get", { target: init.runId });
      assert.equal(detail.run.runId, init.runId);
      assert.equal(detail.run.assignment.name, "daemon-work");

      const tasks = await client.call("tasks.list", { target: init.runId });
      assert.equal(tasks.tasks.length, 1);
      assert.equal(tasks.tasks[0].id, "t1");

      const updated = await client.call("tasks.set", {
        target: init.runId,
        taskId: "t1",
        status: "completed",
        notes: "Handled through daemon RPC.",
      });
      assert.equal(updated.task.status, "completed");
      assert.equal(updated.task.notes, "Handled through daemon RPC.");

      const agents = await client.call("agents.list");
      assert.ok(agents.agents.some((entry) => entry.name === "daemon-agent"));

      const assignment = await client.call("assignments.get", { target: "daemon-work", cwd: dir });
      assert.equal(assignment.assignment.config.name, "daemon-work");
    } finally {
      await client.close();
      await server.close();
    }
  });
});

test("daemon subscriptions fan out run events and abort active runs", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl, {
    async startRun({ emitEvent, abortSignal }) {
      const runId = "daemon-live-run";
      const summary = {
        status: "aborted",
        attempts: 1,
        maxAttempts: 1,
        tasksCompleted: 0,
        tasksTotal: 0,
        assignmentPath: "/tmp/fake/assignment.md",
        tasks: [],
        runId,
      };
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        assignmentPath: summary.assignmentPath,
        sessionName: "daemon test",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({ type: "attempt_started", attempt: 1 });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            emitEvent({ type: "run_aborted" });
            emitEvent({ type: "run_finished", summary });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  const clientA = await DaemonClient.connect(listenUrl);
  const clientB = await DaemonClient.connect(listenUrl);
  const seenA = [];
  const seenB = [];
  try {
    await clientA.subscribe({}, (msg) => seenA.push(msg.event.type));
    await clientB.subscribe({}, (msg) => seenB.push(msg.event.type));

    const started = await clientA.call("runs.start", { cliVars: {}, overrides: {} });
    assert.equal(started.runId, "daemon-live-run");

    await clientB.call("runs.abort", { target: started.runId });

    await new Promise((resolve) => setTimeout(resolve, 50));

    assert.deepEqual(seenA, ["run_started", "attempt_started", "run_aborted", "run_finished"]);
    assert.deepEqual(seenB, ["run_started", "attempt_started", "run_aborted", "run_finished"]);
  } finally {
    await clientA.close();
    await clientB.close();
    await server.close();
  }
});

test("daemon close aborts active runs and releases connected clients", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let aborted = false;
  const server = await serveDaemon(listenUrl, {
    async startRun({ emitEvent, abortSignal }) {
      const runId = "daemon-close-run";
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        assignmentPath: "/tmp/fake/assignment.md",
        sessionName: "daemon close",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            aborted = true;
            emitEvent({ type: "run_aborted" });
            emitEvent({
              type: "run_finished",
              summary: {
                status: "aborted",
                attempts: 1,
                maxAttempts: 1,
                tasksCompleted: 0,
                tasksTotal: 0,
                assignmentPath: "/tmp/fake/assignment.md",
                tasks: [],
                runId,
              },
            });
            resolve();
          },
          { once: true },
        );
      });
      return { runId };
    },
  });

  const client = await DaemonClient.connect(listenUrl);
  try {
    const started = await client.call("runs.start", { cliVars: {}, overrides: {} });
    assert.equal(started.runId, "daemon-close-run");
    await server.close();
    assert.equal(aborted, true);
  } finally {
    await client.close().catch(() => undefined);
  }
});

test("daemon returns JSON-RPC errors for malformed requests", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl);
  const ws = await openRawWebSocket(listenUrl);
  try {
    ws.send("{");
    const parseError = await nextRawMessage(ws);
    assert.equal(parseError.id, null);
    assert.equal(parseError.error.code, -32700);

    ws.send(JSON.stringify({ jsonrpc: "2.0", id: "bad-request" }));
    const invalidRequest = await nextRawMessage(ws);
    assert.equal(invalidRequest.id, "bad-request");
    assert.equal(invalidRequest.error.code, -32600);
  } finally {
    ws.close();
    await server.close();
  }
});

test("daemon validates override payloads before calling shared services", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let invoked = false;
  const server = await serveDaemon(listenUrl, {
    async startRun() {
      invoked = true;
      return { runId: "unexpected" };
    },
  });
  const client = await DaemonClient.connect(listenUrl);
  try {
    await assert.rejects(
      () =>
        client.call("runs.start", {
          cliVars: {},
          overrides: { taskMode: "bogus" },
        }),
      /overrides\.taskMode must be one of: file, cli/,
    );
    assert.equal(invoked, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("serve and --connect route CLI commands remotely and fail clearly when no daemon is available", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;

  const unavailable = runCliExpectFail(["status", init.runId, "--connect", listenUrl], {
    cwd: dir,
  });
  assert.equal(unavailable.status, 3);
  assert.match(unavailable.stderr, /cannot connect to daemon/);
  assert.match(unavailable.stderr, new RegExp(`serve --listen ${listenUrl}`));

  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const agentsText = runCli(["list", "agents", "--connect", listenUrl], { cwd: dir });
    assert.match(agentsText, /daemon-agent/);

    const statusViaEnv = runCli(["status", init.runId], {
      cwd: dir,
      env: { TASK_RUNNER_CONNECT: listenUrl },
    });
    assert.match(statusViaEnv, new RegExp(`── run ${init.runId} ──`));

    const client = await DaemonClient.connect(listenUrl);
    try {
      const info = await client.call("daemon.info");
      assert.equal(info.listenUrl, listenUrl);
    } finally {
      await client.close();
    }
  } finally {
    await daemon.stop();
  }
});
