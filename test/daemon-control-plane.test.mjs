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
import { deriveHttpBaseUrl } from "../dist/daemon/config.js";
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

async function httpJson(baseUrl, path, opts = {}) {
  const response = await fetch(new URL(path, baseUrl), opts);
  const text = await response.text();
  return {
    status: response.status,
    headers: response.headers,
    body: text.length > 0 ? JSON.parse(text) : null,
  };
}

async function openSse(baseUrl, path) {
  const controller = new AbortController();
  const response = await fetch(new URL(path, baseUrl), {
    headers: { accept: "text/event-stream" },
    signal: controller.signal,
  });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /text\/event-stream/);

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  return {
    async next() {
      while (true) {
        const boundary = buffer.indexOf("\n\n");
        if (boundary !== -1) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const dataLine = frame.split("\n").find((line) => line.startsWith("data: "));
          if (!dataLine) {
            continue;
          }
          return JSON.parse(dataLine.slice(6));
        }

        const { done, value } = await reader.read();
        if (done) {
          throw new Error("SSE stream ended before next event");
        }
        buffer += decoder.decode(value, { stream: true });
      }
    },
    async close() {
      controller.abort();
      await reader.cancel().catch(() => undefined);
    },
    async waitForClose() {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            return;
          }
          buffer += decoder.decode(value, { stream: true });
        }
      } catch {
        // Connection teardown may surface as a stream read error instead of EOF.
      }
    },
  };
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
    async stop(signal = "SIGINT") {
      child.kill(signal);
      return await new Promise((resolve) =>
        child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })),
      );
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

test("daemon HTTP routes mirror shared run/task DTOs and error envelopes", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const daemon = await httpJson(httpBaseUrl, "/api/daemon");
      assert.equal(daemon.status, 200);
      assert.equal(daemon.body.daemon.listenUrl, listenUrl);

      const runs = await httpJson(httpBaseUrl, "/api/runs");
      assert.equal(runs.status, 200);
      assert.equal(runs.body.runs[0].runId, init.runId);

      const detail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.assignment.name, "daemon-work");

      const tasks = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks`);
      assert.equal(tasks.status, 200);
      assert.equal(tasks.body.tasks[0].id, "t1");

      const updated = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks/t1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed", notes: "Handled over HTTP." }),
      });
      assert.equal(updated.status, 200);
      assert.equal(updated.body.task.status, "completed");
      assert.equal(updated.body.task.notes, "Handled over HTTP.");

      const appended = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/tasks/t1/append-notes`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: "Second line." }),
        },
      );
      assert.equal(appended.status, 200);
      assert.match(appended.body.task.notes, /Handled over HTTP\.\nSecond line\./);

      const added = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ title: "Follow-up task", body: "via HTTP" }),
      });
      assert.equal(added.status, 200);
      assert.equal(added.body.task.title, "Follow-up task");

      const notFound = await httpJson(httpBaseUrl, "/api/runs/missing-run");
      assert.equal(notFound.status, 404);
      assert.equal(notFound.body.error.code, "NOT_FOUND");

      const badQuery = await httpJson(httpBaseUrl, "/api/runs?includeArchived=maybe");
      assert.equal(badQuery.status, 400);
      assert.equal(badQuery.body.error.code, "INVALID_REQUEST");

      const invalidStatus = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/tasks/t1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "bogus" }),
      });
      assert.equal(invalidStatus.status, 400);
      assert.equal(invalidStatus.body.error.code, "INVALID_REQUEST");

      const malformed = await fetch(new URL(`/api/runs/${init.runId}/tasks/t1`, httpBaseUrl), {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: "{",
      });
      const malformedBody = await malformed.json();
      assert.equal(malformed.status, 400);
      assert.equal(malformedBody.error.code, "INVALID_REQUEST");
    } finally {
      await server.close();
    }
  });
});

test("daemon HTTP rejects oversized JSON request bodies", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    try {
      const oversizedPayload = JSON.stringify({
        cliVars: {
          blob: "x".repeat(1024 * 1024),
        },
        overrides: {},
      });
      const response = await fetch(new URL("/api/runs", httpBaseUrl), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: oversizedPayload,
      });
      const body = await response.json();
      assert.equal(response.status, 400);
      assert.equal(body.error.code, "INVALID_REQUEST");
      assert.match(body.error.message, /request body exceeds/i);
    } finally {
      await server.close();
    }
  });
});

test("daemon HTTP rejects encoded traversal route params without leaking paths", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const server = await serveDaemon(listenUrl);
  try {
    const response = await httpJson(httpBaseUrl, "/api/runs/..%2F..%2Fetc/tasks");
    assert.equal(response.status, 404);
    assert.equal(response.body.error.code, "NOT_FOUND");
    assert.equal(response.body.error.message, "resource not found");
  } finally {
    await server.close();
  }
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

test("daemon SSE streams reuse run event fan-out for all-runs and per-run subscriptions", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const server = await serveDaemon(listenUrl, {
    async startRun({ emitEvent, abortSignal }) {
      const runId = "daemon-sse-run";
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        assignmentPath: "/tmp/fake/assignment.md",
        sessionName: "daemon sse",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({ type: "attempt_started", attempt: 1 });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
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

  const allRuns = await openSse(httpBaseUrl, "/api/events/runs");
  const oneRun = await openSse(httpBaseUrl, "/api/events/runs/daemon-sse-run");
  try {
    const started = await httpJson(httpBaseUrl, "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliVars: {}, overrides: {} }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runId, "daemon-sse-run");

    const allStarted = await allRuns.next();
    const oneStarted = await oneRun.next();
    assert.equal(allStarted.runId, "daemon-sse-run");
    assert.equal(allStarted.event.type, "run_started");
    assert.equal(oneStarted.runId, "daemon-sse-run");
    assert.equal(oneStarted.event.type, "run_started");

    const allAttempt = await allRuns.next();
    const oneAttempt = await oneRun.next();
    assert.equal(allAttempt.event.type, "attempt_started");
    assert.equal(oneAttempt.event.type, "attempt_started");

    const aborted = await httpJson(httpBaseUrl, "/api/runs/daemon-sse-run/abort", {
      method: "POST",
    });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body.accepted, true);

    assert.equal((await allRuns.next()).event.type, "run_aborted");
    assert.equal((await oneRun.next()).event.type, "run_aborted");
    assert.equal((await allRuns.next()).event.type, "run_finished");
    assert.equal((await oneRun.next()).event.type, "run_finished");
  } finally {
    await allRuns.close();
    await oneRun.close();
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

test("daemon close terminates active SSE streams promptly", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const server = await serveDaemon(listenUrl);
  const events = await openSse(httpBaseUrl, "/api/events/runs");
  try {
    await Promise.race([
      (async () => {
        await server.close();
        await events.waitForClose();
      })(),
      new Promise((_, reject) => {
        setTimeout(() => reject(new Error("timed out waiting for SSE shutdown")), 1000);
      }),
    ]);
  } finally {
    await events.close().catch(() => undefined);
  }
});

test("serveDaemon waits for bind errors before returning", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl);
  try {
    await assert.rejects(() => serveDaemon(listenUrl), /EADDRINUSE|address already in use/i);
  } finally {
    await server.close();
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
    await assert.rejects(
      () =>
        client.call("runs.start", {
          cliVars: {},
          overrides: { timeoutSec: 1.5 },
        }),
      /overrides\.timeoutSec must be a positive integer/,
    );
    await assert.rejects(
      () =>
        client.call("runs.start", {
          cliVars: {},
          overrides: { maxRetries: 1.5 },
        }),
      /overrides\.maxRetries must be a non-negative integer/,
    );
    assert.equal(invoked, false);
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon runs.start keeps callerCwd separate from overrides.cwd", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const callerCwd = "/tmp/daemon-start-caller";
  let seenCallerCwd;
  let seenOverrideCwd;
  const server = await serveDaemon(listenUrl, {
    async startRun(request) {
      seenCallerCwd = request.callerCwd;
      seenOverrideCwd = request.overrides.cwd;
      return { runId: "daemon-start-cwd" };
    },
  });
  const client = await DaemonClient.connect(listenUrl);
  try {
    const started = await client.call("runs.start", {
      callerCwd,
      cliVars: {},
      overrides: {},
    });
    assert.equal(started.runId, "daemon-start-cwd");
    assert.equal(seenCallerCwd, callerCwd);
    assert.equal(seenOverrideCwd, undefined);
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon HTTP run start keeps callerCwd separate from overrides.cwd", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const callerCwd = "/tmp/http-start-caller";
  let seenCallerCwd;
  let seenOverrideCwd;
  const server = await serveDaemon(listenUrl, {
    async startRun(request) {
      seenCallerCwd = request.callerCwd;
      seenOverrideCwd = request.overrides.cwd;
      return { runId: "http-start-cwd" };
    },
  });
  try {
    const started = await httpJson(httpBaseUrl, "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callerCwd,
        cliVars: {},
        overrides: {},
      }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runId, "http-start-cwd");
    assert.equal(seenCallerCwd, callerCwd);
    assert.equal(seenOverrideCwd, undefined);
  } finally {
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

test("serve exposes HTTP/SSE alongside the existing WebSocket RPC transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const client = await DaemonClient.connect(listenUrl);
    try {
      const info = await client.call("daemon.info");
      assert.equal(info.listenUrl, listenUrl);
    } finally {
      await client.close();
    }

    const status = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
    assert.equal(status.status, 200);
    assert.equal(status.body.run.runId, init.runId);

    const events = await openSse(httpBaseUrl, `/api/events/runs/${init.runId}`);
    await events.close();
  } finally {
    await daemon.stop();
  }
});

test("serve exits cleanly on SIGTERM", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const result = await daemon.stop("SIGTERM");
    assert.equal(result.code, 0);
    assert.equal(result.signal, null);
  } finally {
    // no-op if already stopped
  }
});

test("serve exits 130 on SIGINT", async () => {
  const dir = tempDir();
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(dir, listenUrl);
  try {
    const result = await daemon.stop("SIGINT");
    assert.equal(result.code, 130);
    assert.equal(result.signal, null);
  } finally {
    // no-op if already stopped
  }
});

test("daemon HTTP init uses the remote caller cwd when the agent omits cwd", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  const clientDir = tempDir();

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  try {
    const run = await httpJson(httpBaseUrl, "/api/runs/init", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        agent: join(daemonDir, "agents", "daemon-agent", "agent.md"),
        assignment: join(daemonDir, "assignments", "daemon-work", "assignment.md"),
        callerCwd: clientDir,
        cliVars: {},
        overrides: {},
      }),
    });
    assert.equal(run.status, 200);
    assert.equal(run.body.run.cwd, clientDir);
  } finally {
    await daemon.stop();
  }
});

test("daemon init uses the remote caller cwd when the agent omits cwd", async () => {
  const daemonDir = tempDir();
  writeAgent(daemonDir, "daemon-agent", AGENT);
  writeAssignment(daemonDir, "daemon-work", ASSIGNMENT);
  const clientDir = tempDir();

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const daemon = await startCliDaemon(daemonDir, listenUrl);
  try {
    const output = runCli(
      [
        "init",
        "--connect",
        listenUrl,
        "--agent",
        join(daemonDir, "agents", "daemon-agent", "agent.md"),
        "--assignment",
        join(daemonDir, "assignments", "daemon-work", "assignment.md"),
        "--output-format",
        "json",
      ],
      { cwd: clientDir },
    );
    const run = JSON.parse(output);
    assert.equal(run.cwd, clientDir);
  } finally {
    await daemon.stop();
  }
});
