import { strict as assert } from "node:assert";
import { execFileSync, spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import WebSocket, { WebSocketServer } from "ws";
import { DaemonClient, DaemonRpcError } from "../apps/cli/dist/daemon/client.js";
import { deriveHttpBaseUrl } from "../apps/cli/dist/daemon/config.js";
import { serveDaemon } from "../apps/cli/dist/daemon/server.js";
import { streamEvents } from "../apps/cli/dist/daemon/sse.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { sharedRuntimeEnv, withEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: daemon-agent
backend: claude
model: claude-sonnet-4-6
---
Daemon agent.
`;

const PASSIVE_AGENT = `---
schemaVersion: 1
name: passive-daemon-agent
backend: passive
---
Passive daemon agent.
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

async function initRun(baseDir, agentName = "daemon-agent") {
  return withEnv(sharedRuntimeEnv(baseDir), async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
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

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

function patchManifest(workspaceDir, mutator) {
  const manifestPath = join(workspaceDir, "run.json");
  const manifest = readManifest(workspaceDir);
  mutator(manifest);
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
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

class FakeSseResponse extends EventEmitter {
  constructor(writeResults = []) {
    super();
    this.destroyed = false;
    this.headers = new Map();
    this.writeResults = writeResults;
    this.writableEnded = false;
  }

  flushHeaders() {}

  setHeader(name, value) {
    this.headers.set(name.toLowerCase(), value);
  }

  write(chunk) {
    this.lastChunk = chunk;
    if (this.writeResults.length > 0) {
      return this.writeResults.shift();
    }
    return true;
  }

  end() {
    this.writableEnded = true;
  }
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

async function runCliAsync(args, opts = {}) {
  const child = spawn("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()), ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  const result = await new Promise((resolve) =>
    child.once("exit", (code, signal) => resolve({ code, signal })),
  );
  return { ...result, stdout, stderr };
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
      assert.match(info.daemonInstanceId, /^daemon-/);

      const runs = await client.call("runs.list", {});
      assert.equal(runs.runs[0].runId, init.runId);
      assert.deepEqual(runs.runs[0].execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.deepEqual(runs.runs[0].capabilities, {
        canArchive: true,
        canUnarchive: false,
        canResume: true,
        canAbort: false,
        abortReason: "not_active_in_daemon",
        taskMutation: {
          canSetStatus: true,
          canEditNotes: true,
          canAdd: true,
        },
      });
      assert.deepEqual(runs.runs[0].dependencyState, {
        ready: true,
        total: 0,
        satisfied: 0,
        unsatisfied: 0,
      });

      const detail = await client.call("runs.get", { target: init.runId });
      assert.equal(detail.run.runId, init.runId);
      assert.equal(detail.run.assignment.name, "daemon-work");
      assert.equal(detail.run.name, null);
      assert.deepEqual(detail.run.dependencies, []);
      assert.deepEqual(detail.run.dependents, []);
      assert.deepEqual(detail.run.execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.equal(detail.run.capabilities.canAbort, false);
      assert.equal(detail.run.capabilities.abortReason, "not_active_in_daemon");

      const dependency = await initRun(dir);
      const addedDependency = await client.call("runs.addDependency", {
        target: init.runId,
        dependencyRunId: dependency.runId,
      });
      assert.deepEqual(addedDependency.result, {
        runId: init.runId,
        dependencyRunIds: [dependency.runId],
        changed: true,
      });

      const removedDependency = await client.call("runs.removeDependency", {
        target: init.runId,
        dependencyRunId: dependency.runId,
      });
      assert.deepEqual(removedDependency.result, {
        runId: init.runId,
        dependencyRunIds: [],
        changed: true,
      });

      const clearedDependencies = await client.call("runs.clearDependencies", {
        target: init.runId,
      });
      assert.deepEqual(clearedDependencies.result, {
        runId: init.runId,
        dependencyRunIds: [],
        changed: false,
      });

      const renamed = await client.call("runs.setName", {
        target: init.runId,
        name: "RPC renamed run",
      });
      assert.deepEqual(renamed.result, {
        runId: init.runId,
        name: "RPC renamed run",
        changed: true,
      });

      const renamedDetail = await client.call("runs.get", { target: init.runId });
      assert.equal(renamedDetail.run.name, "RPC renamed run");

      const cleared = await client.call("runs.setName", {
        target: init.runId,
        name: null,
      });
      assert.deepEqual(cleared.result, {
        runId: init.runId,
        name: null,
        changed: true,
      });

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
      assert.match(daemon.body.daemon.daemonInstanceId, /^daemon-/);

      const runs = await httpJson(httpBaseUrl, "/api/runs");
      assert.equal(runs.status, 200);
      assert.equal(runs.body.runs[0].runId, init.runId);
      assert.equal(runs.body.runs[0].status, "initialized");
      assert.equal(runs.body.runs[0].effectiveStatus, "initialized");
      assert.deepEqual(runs.body.runs[0].dependencyState, {
        ready: true,
        total: 0,
        satisfied: 0,
        unsatisfied: 0,
      });
      assert.deepEqual(runs.body.runs[0].execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.equal(runs.body.runs[0].capabilities.canAbort, false);
      assert.equal(runs.body.runs[0].capabilities.abortReason, "not_active_in_daemon");

      const detail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(detail.status, 200);
      assert.equal(detail.body.run.assignment.name, "daemon-work");
      assert.equal(detail.body.run.name, null);
      assert.equal(detail.body.run.status, "initialized");
      assert.equal(detail.body.run.effectiveStatus, "initialized");
      assert.deepEqual(detail.body.run.dependencies, []);
      assert.deepEqual(detail.body.run.dependents, []);
      assert.deepEqual(detail.body.run.execution, {
        hostMode: "embedded",
        controller: { kind: "embedded" },
      });
      assert.equal(detail.body.run.capabilities.canAbort, false);
      assert.equal(detail.body.run.capabilities.abortReason, "not_active_in_daemon");

      const dependency = await initRun(dir);
      const addedDependency = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/dependencies`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dependencyRunId: dependency.runId }),
      });
      assert.equal(addedDependency.status, 200);
      assert.deepEqual(addedDependency.body.result, {
        runId: init.runId,
        dependencyRunIds: [dependency.runId],
        changed: true,
      });

      const removedDependency = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/dependencies/${dependency.runId}`,
        {
          method: "DELETE",
        },
      );
      assert.equal(removedDependency.status, 200);
      assert.deepEqual(removedDependency.body.result, {
        runId: init.runId,
        dependencyRunIds: [],
        changed: true,
      });

      const clearedDependencies = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/dependencies/clear`,
        {
          method: "POST",
        },
      );
      assert.equal(clearedDependencies.status, 200);
      assert.deepEqual(clearedDependencies.body.result, {
        runId: init.runId,
        dependencyRunIds: [],
        changed: false,
      });

      const renamed = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "HTTP renamed run" }),
      });
      assert.equal(renamed.status, 200);
      assert.deepEqual(renamed.body.result, {
        runId: init.runId,
        name: "HTTP renamed run",
        changed: true,
      });

      const renamedDetail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(renamedDetail.status, 200);
      assert.equal(renamedDetail.body.run.name, "HTTP renamed run");

      const cleared = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/name`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: null }),
      });
      assert.equal(cleared.status, 200);
      assert.deepEqual(cleared.body.result, {
        runId: init.runId,
        name: null,
        changed: true,
      });

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

      const invalidDependencyRequest = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/dependencies`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      assert.equal(invalidDependencyRequest.status, 400);
      assert.equal(invalidDependencyRequest.body.error.code, "INVALID_REQUEST");

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

test("daemon attachment HTTP routes upload, list, download, remove, and reject max-count overflow", async () => {
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
      const uploaded = await fetch(new URL(`/api/runs/${init.runId}/attachments`, httpBaseUrl), {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-task-runner-attachment-name": "evidence.txt",
        },
        body: Buffer.from("evidence payload\n"),
      });
      const uploadedBody = await uploaded.json();
      assert.equal(uploaded.status, 200);
      assert.equal(uploadedBody.attachment.name, "evidence.txt");
      assert.equal(uploadedBody.attachment.mimeType, "text/plain");

      const attachmentId = uploadedBody.attachment.id;
      const listed = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/attachments`);
      assert.equal(listed.status, 200);
      assert.equal(listed.body.attachments.length, 1);
      assert.equal(listed.body.attachments[0].id, attachmentId);

      const content = await fetch(
        new URL(`/api/runs/${init.runId}/attachments/${attachmentId}/content`, httpBaseUrl),
      );
      assert.equal(content.status, 200);
      assert.equal(await content.text(), "evidence payload\n");
      assert.equal(content.headers.get("x-task-runner-attachment-id"), attachmentId);
      assert.equal(content.headers.get("x-task-runner-sha256"), uploadedBody.attachment.sha256);
      assert.match(
        content.headers.get("content-disposition") ?? "",
        /attachment; filename\*=UTF-8''evidence\.txt/,
      );

      const removed = await httpJson(
        httpBaseUrl,
        `/api/runs/${init.runId}/attachments/${attachmentId}`,
        {
          method: "DELETE",
        },
      );
      assert.equal(removed.status, 200);
      assert.deepEqual(removed.body.result, {
        runId: init.runId,
        attachmentId,
        changed: true,
      });

      patchManifest(init.workspaceDir, (manifest) => {
        manifest.attachments = Array.from({ length: 20 }, (_, index) => ({
          id: `att-${index}`,
          name: `existing-${index}.txt`,
          mimeType: "text/plain",
          size: 1,
          sha256: `${index}`.padStart(64, "0"),
          addedAt: "2026-04-14T00:00:00.000Z",
          relativePath: `attachments/att-${index}/existing-${index}.txt`,
        }));
      });

      const rejected = await fetch(new URL(`/api/runs/${init.runId}/attachments`, httpBaseUrl), {
        method: "POST",
        headers: {
          "content-type": "text/plain",
          "x-task-runner-attachment-name": "overflow.txt",
        },
        body: Buffer.from("x"),
      });
      const rejectedBody = await rejected.json();
      assert.equal(rejected.status, 422);
      assert.equal(rejectedBody.error.code, "INVALID_COMMAND");
      assert.match(rejectedBody.error.message, /already has 20 attachments/);
    } finally {
      await server.close();
    }
  });
});

test("daemon serve exposes app config, keeps /api precedence, and falls back to SPA routes", async () => {
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
      const appConfig = await httpJson(httpBaseUrl, "/app-config.json");
      assert.equal(appConfig.status, 200);
      assert.deepEqual(appConfig.body, {
        apiBasePath: "/api",
        runSummaryEventsPath: "/api/events/run-summaries",
      });

      const apiDetail = await httpJson(httpBaseUrl, `/api/runs/${init.runId}`);
      assert.equal(apiDetail.status, 200);
      assert.equal(apiDetail.body.run.runId, init.runId);
      assert.equal(apiDetail.body.run.effectiveStatus, "initialized");

      const spaRoot = await fetch(new URL("/", httpBaseUrl));
      const spaRootBody = await spaRoot.text();
      assert.equal(spaRoot.status, 200);
      assert.match(spaRoot.headers.get("content-type") ?? "", /text\/html/);
      assert.match(spaRootBody, /<div id="root"><\/div>/);

      const deepLink = await fetch(new URL(`/runs/${init.runId}`, httpBaseUrl));
      const deepLinkBody = await deepLink.text();
      assert.equal(deepLink.status, 200);
      assert.match(deepLinkBody, /<div id="root"><\/div>/);

      const assetsDirectory = await fetch(new URL("/assets", httpBaseUrl));
      const assetsDirectoryBody = await assetsDirectory.text();
      assert.equal(assetsDirectory.status, 200);
      assert.match(assetsDirectoryBody, /<div id="root"><\/div>/);

      const daemonAfterAssets = await httpJson(httpBaseUrl, "/api/daemon");
      assert.equal(daemonAfterAssets.status, 200);
      assert.equal(daemonAfterAssets.body.daemon.listenUrl, listenUrl);
    } finally {
      await server.close();
    }
  });
});

test("daemon serve reads packaged web assets from the CLI dist layout", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const packagedIndex = readFileSync(
    new URL("../apps/cli/dist/web/index.html", import.meta.url),
    "utf8",
  );

  const server = await serveDaemon(listenUrl);
  try {
    const response = await fetch(new URL("/", httpBaseUrl));
    const body = await response.text();
    assert.equal(response.status, 200);
    assert.equal(body, packagedIndex);

    const assetPath = body.match(/\/assets\/[^"]+\.(?:js|css)/)?.[0];
    assert.ok(assetPath, "expected built asset path in served index.html");

    const assetResponse = await fetch(new URL(assetPath, httpBaseUrl));
    const assetBody = await assetResponse.text();
    assert.equal(assetResponse.status, 200);
    assert.ok(assetBody.length > 0);
  } finally {
    await server.close();
  }
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

test("daemon dependency mutation surfaces reject path-like dependency ids over RPC and HTTP", async () => {
  const dir = tempDir();
  writeAgent(dir, "daemon-agent", AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const init = await initRun(dir);
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const server = await serveDaemon(listenUrl);
  const client = await DaemonClient.connect(listenUrl);

  try {
    await assert.rejects(
      () =>
        client.call("runs.addDependency", {
          target: init.runId,
          dependencyRunId: "../other-run",
        }),
      (err) =>
        err instanceof DaemonRpcError &&
        err.message === "dependencyRunId must be a run id, not a path",
    );

    const response = await httpJson(httpBaseUrl, `/api/runs/${init.runId}/dependencies`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ dependencyRunId: "../other-run" }),
    });
    assert.equal(response.status, 400);
    assert.equal(response.body.error.code, "INVALID_REQUEST");
    assert.equal(response.body.error.message, "dependencyRunId must be a run id, not a path");
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon run projections expose explicit abort capability from local ownership", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let daemonInstanceId = "daemon-placeholder";
  const runId = "daemon-owned-run";
  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "task-runner",
        status: "running",
        effectiveStatus: "running",
        archivedAt: null,
        isLive: true,
        workspaceDir: "/tmp/fake",
        assignmentPath: "/tmp/fake/assignment.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "Daemon-owned run",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: null,
        exitCode: null,
        attempts: 1,
        maxAttempts: 1,
        sessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 1,
        activeTask: null,
        tasks: [
          {
            id: "t1",
            title: "First",
            body: "",
            status: "pending",
            notes: "",
          },
        ],
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId,
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: false,
          abortReason: "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
          status: "running",
          effectiveStatus: "running",
          archivedAt: null,
          agentName: "daemon-agent",
          name: "Daemon-owned run",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: null,
          tasksCompleted: 0,
          tasksTotal: 1,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask: null,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId,
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: false,
            abortReason: "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent, abortSignal }) {
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        assignmentPath: "/tmp/fake/assignment.md",
        name: "Daemon-owned run",
        cwd: "/tmp/fake",
        sessionIndex: 1,
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
                tasksTotal: 1,
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
    daemonInstanceId = (await client.call("daemon.info")).daemonInstanceId;
    const started = await client.call("runs.start", { cliVars: {}, overrides: {} });
    assert.equal(started.runId, runId);

    const list = await client.call("runs.list", {});
    assert.equal(list.runs[0].capabilities.canAbort, true);
    assert.equal("abortReason" in list.runs[0].capabilities, false);
    assert.deepEqual(list.runs[0].execution, {
      hostMode: "daemon",
      controller: {
        kind: "daemon",
        daemonInstanceId,
      },
    });

    const detail = await client.call("runs.get", { target: runId });
    assert.equal(detail.run.capabilities.canAbort, true);
    assert.equal("abortReason" in detail.run.capabilities, false);
    assert.deepEqual(detail.run.execution, {
      hostMode: "daemon",
      controller: {
        kind: "daemon",
        daemonInstanceId,
      },
    });

    await client.call("runs.abort", { target: runId });
  } finally {
    await client.close();
    await server.close();
  }
});

test("daemon subscriptions fan out run events and abort active runs", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let status = "running";
  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId: "daemon-live-run",
        repo: "task-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: status === "running",
        workspaceDir: "/tmp/fake",
        assignmentPath: "/tmp/fake/assignment.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "daemon test",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: status === "aborted" ? "2026-04-13T05:05:00.000Z" : null,
        exitCode: status === "aborted" ? 130 : null,
        attempts: 1,
        maxAttempts: 1,
        sessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 0,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [],
        activeTask: null,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: status === "running",
          abortReason: status === "running" ? undefined : "already_terminal",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
          },
        },
      };
    },
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
        name: "daemon test",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({ type: "attempt_started", attempt: 1 });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            status = "aborted";
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
    const started = await clientA.call("runs.start", { cliVars: {}, overrides: {} });
    assert.equal(started.runId, "daemon-live-run");
    await clientA.subscribe({ channel: "run_timeline", runId: started.runId }, (msg) => {
      if (msg.method === "run.timeline") {
        seenA.push(msg.event.type);
      }
    });
    await clientB.subscribe({ channel: "run_timeline", runId: started.runId }, (msg) => {
      if (msg.method === "run.timeline") {
        seenB.push(msg.event.type);
      }
    });

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

test("daemon mutation-driven projection SSE events include dependent summary fanout", async () => {
  const dir = tempDir();
  writeAgent(dir, "passive-daemon-agent", PASSIVE_AGENT);
  writeAssignment(dir, "daemon-work", ASSIGNMENT);
  const source = await initRun(dir, "passive-daemon-agent");
  const dependent = await initRun(dir, "passive-daemon-agent");
  patchManifest(dependent.workspaceDir, (manifest) => {
    manifest.dependencyRunIds = [source.runId];
  });

  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  await withEnv(sharedRuntimeEnv(dir), async () => {
    const server = await serveDaemon(listenUrl);
    const summaries = await openSse(httpBaseUrl, "/api/events/run-summaries");
    const sourceDetails = await openSse(httpBaseUrl, `/api/runs/${source.runId}/events/detail`);
    try {
      const response = await httpJson(httpBaseUrl, `/api/runs/${source.runId}/tasks/t1`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ status: "completed" }),
      });
      assert.equal(response.status, 200);
      assert.equal(response.body.task.status, "completed");

      const sourceSummary = await summaries.next();
      const sourceDetailEvent = await sourceDetails.next();
      const dependentSummary = await summaries.next();

      assert.equal(sourceSummary.type, "summary_upsert");
      assert.equal(sourceSummary.summary.runId, source.runId);
      assert.equal(sourceSummary.summary.effectiveStatus, "success");

      assert.equal(sourceDetailEvent.type, "detail_updated");
      assert.equal(sourceDetailEvent.detail.runId, source.runId);
      assert.equal(sourceDetailEvent.detail.effectiveStatus, "success");

      assert.equal(dependentSummary.type, "summary_upsert");
      assert.equal(dependentSummary.summary.runId, dependent.runId);
      assert.deepEqual(dependentSummary.summary.dependencyState, {
        ready: true,
        total: 1,
        satisfied: 1,
        unsatisfied: 0,
      });
    } finally {
      await summaries.close();
      await sourceDetails.close();
      await server.close();
    }
  });
});

test("daemon websocket validates events.subscribe channel and runId rules", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const server = await serveDaemon(listenUrl);
  const ws = await openRawWebSocket(listenUrl);
  try {
    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "events.subscribe",
        params: { channel: "bogus" },
      }),
    );
    const invalidChannel = await nextRawMessage(ws);
    assert.equal(
      invalidChannel.error.message,
      'channel must be one of "run_summary", "run_detail", or "run_timeline"',
    );

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "events.subscribe",
        params: { channel: "run_summary", runId: "run-123" },
      }),
    );
    const summaryWithRunId = await nextRawMessage(ws);
    assert.equal(summaryWithRunId.error.message, "runId must be omitted for channel run_summary");

    ws.send(
      JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "events.subscribe",
        params: { channel: "run_detail" },
      }),
    );
    const missingRunId = await nextRawMessage(ws);
    assert.equal(missingRunId.error.message, "runId is required");
  } finally {
    ws.terminate();
    await server.close();
  }
});

test("daemon SSE streams split summary, detail, and timeline subscriptions", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const httpBaseUrl = deriveHttpBaseUrl(listenUrl);
  const runId = "daemon-sse-run";
  let status = "initialized";
  let activeTask = null;
  const server = await serveDaemon(listenUrl, {
    getRun() {
      return {
        runId,
        repo: "task-runner",
        status,
        effectiveStatus: status,
        archivedAt: null,
        isLive: status === "running",
        workspaceDir: "/tmp/fake",
        assignmentPath: "/tmp/fake/assignment.md",
        agent: {
          name: "daemon-agent",
          sourcePath: null,
        },
        assignment: {
          name: "daemon-work",
          sourcePath: "/tmp/fake/source.md",
          workspacePath: "/tmp/fake/assignment.md",
        },
        backend: "codex",
        model: "gpt-5.4",
        effort: "high",
        name: "daemon sse",
        backendSessionId: "thread-1",
        cwd: "/tmp/fake",
        unrestricted: false,
        timeoutSec: 3600,
        startedAt: "2026-04-13T05:00:00.000Z",
        endedAt: status === "aborted" ? "2026-04-13T05:05:00.000Z" : null,
        exitCode: status === "aborted" ? 130 : null,
        attempts: 1,
        maxAttempts: 1,
        sessionCount: 1,
        tasksCompleted: 0,
        tasksTotal: 1,
        attachments: [],
        dependencies: [],
        dependents: [],
        tasks: [
          {
            id: "t1",
            title: "First",
            body: "",
            status: activeTask ? "in_progress" : "pending",
            notes: "",
          },
        ],
        activeTask,
        message: null,
        callerInstructions: null,
        lockedFields: [],
        runtimeVars: {},
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-placeholder",
          },
        },
        capabilities: {
          canArchive: false,
          canUnarchive: false,
          canResume: false,
          canAbort: status === "running",
          abortReason: status === "running" ? undefined : "not_active_in_daemon",
          taskMutation: {
            canSetStatus: false,
            canEditNotes: false,
            canAdd: false,
          },
        },
      };
    },
    getRunList() {
      return [
        {
          runId,
          repo: "task-runner",
          status,
          effectiveStatus: status,
          archivedAt: null,
          agentName: "daemon-agent",
          name: "daemon sse",
          assignmentName: "daemon-work",
          backend: "codex",
          model: "gpt-5.4",
          cwd: "/tmp/fake",
          startedAt: "2026-04-13T05:00:00.000Z",
          endedAt: status === "aborted" ? "2026-04-13T05:05:00.000Z" : null,
          tasksCompleted: 0,
          tasksTotal: 1,
          attachmentCount: 0,
          dependencyState: {
            ready: true,
            total: 0,
            satisfied: 0,
            unsatisfied: 0,
          },
          activeTask,
          execution: {
            hostMode: "daemon",
            controller: {
              kind: "daemon",
              daemonInstanceId: "daemon-placeholder",
            },
          },
          capabilities: {
            canArchive: false,
            canUnarchive: false,
            canResume: false,
            canAbort: status === "running",
            abortReason: status === "running" ? undefined : "not_active_in_daemon",
            taskMutation: {
              canSetStatus: false,
              canEditNotes: false,
              canAdd: false,
            },
          },
        },
      ];
    },
    async startRun({ emitEvent, abortSignal }) {
      status = "running";
      activeTask = {
        id: "t1",
        title: "First",
      };
      emitEvent({
        type: "run_started",
        runId,
        agentName: "daemon-agent",
        assignmentSourcePath: null,
        assignmentPath: "/tmp/fake/assignment.md",
        name: "daemon sse",
        cwd: process.cwd(),
        sessionIndex: null,
      });
      emitEvent({ type: "attempt_started", attempt: 1 });
      await new Promise((resolve) => {
        abortSignal.addEventListener(
          "abort",
          () => {
            status = "aborted";
            activeTask = null;
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

  const allRuns = await openSse(httpBaseUrl, "/api/events/run-summaries");
  const oneRun = await openSse(httpBaseUrl, `/api/runs/${runId}/events/detail`);
  const timeline = await openSse(httpBaseUrl, `/api/runs/${runId}/events/timeline`);
  try {
    const started = await httpJson(httpBaseUrl, "/api/runs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cliVars: {}, overrides: {} }),
    });
    assert.equal(started.status, 200);
    assert.equal(started.body.runId, runId);

    const allStarted = await allRuns.next();
    const oneStarted = await oneRun.next();
    assert.equal(allStarted.type, "summary_upsert");
    assert.equal(allStarted.summary.runId, runId);
    assert.equal(allStarted.summary.status, "running");
    assert.equal(oneStarted.type, "detail_updated");
    assert.equal(oneStarted.detail.runId, runId);
    assert.equal(oneStarted.detail.status, "running");
    assert.equal((await timeline.next()).type, "run_started");

    assert.equal((await timeline.next()).type, "attempt_started");

    const aborted = await httpJson(httpBaseUrl, `/api/runs/${runId}/abort`, { method: "POST" });
    assert.equal(aborted.status, 200);
    assert.equal(aborted.body.accepted, true);

    const allFinished = await allRuns.next();
    const oneFinished = await oneRun.next();
    assert.equal(allFinished.type, "summary_upsert");
    assert.equal(allFinished.summary.status, "aborted");
    assert.equal(oneFinished.type, "detail_updated");
    assert.equal(oneFinished.detail.status, "aborted");
    assert.equal((await timeline.next()).type, "run_aborted");
    assert.equal((await timeline.next()).type, "run_finished");
  } finally {
    await allRuns.close();
    await oneRun.close();
    await timeline.close();
    await server.close();
  }
});

test("streamEvents keeps SSE subscribers active when writes report backpressure", () => {
  const req = new EventEmitter();
  const res = new FakeSseResponse([true, false]);
  let unsubscribeCount = 0;
  let publish = null;

  streamEvents(req, res, (next) => {
    publish = next;
    return () => {
      unsubscribeCount += 1;
    };
  });

  assert.equal(typeof publish, "function");
  assert.equal(
    publish({
      type: "summary_upsert",
      summary: { runId: "backpressure-run" },
    }),
    true,
  );
  assert.match(res.lastChunk, /backpressure-run/);
  assert.equal(unsubscribeCount, 0);

  req.emit("close");
  assert.equal(unsubscribeCount, 1);
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
        name: "daemon close",
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
  const events = await openSse(httpBaseUrl, "/api/events/run-summaries");
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
          overrides: { bogus: "value" },
        }),
      /overrides\.bogus is not supported/,
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

test("daemon parses and forwards cursor backend overrides", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  let seenBackend;
  const server = await serveDaemon(listenUrl, {
    async startRun(request) {
      seenBackend = request.overrides.backend;
      return { runId: "daemon-cursor-backend" };
    },
  });
  const client = await DaemonClient.connect(listenUrl);
  try {
    const started = await client.call("runs.start", {
      cliVars: {},
      overrides: { backend: "cursor" },
    });
    assert.equal(started.runId, "daemon-cursor-backend");
    assert.equal(seenBackend, "cursor");
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

    const renameText = runCli(
      ["run", "set-name", init.runId, "Remote CLI name", "--connect", listenUrl],
      {
        cwd: dir,
      },
    );
    assert.match(renameText, new RegExp(`set name for run ${init.runId} to "Remote CLI name"`));

    const statusViaEnv = runCli(["status", init.runId], {
      cwd: dir,
      env: { TASK_RUNNER_CONNECT: listenUrl },
    });
    assert.match(statusViaEnv, new RegExp(`── run ${init.runId} ──`));
    assert.match(statusViaEnv, /Name:\s+Remote CLI name/);

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

    const events = await openSse(httpBaseUrl, "/api/events/run-summaries");
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
    assert.equal(run.execution.hostMode, "daemon");
    assert.equal(run.execution.controller.kind, "daemon");
    assert.match(run.execution.controller.daemonInstanceId, /^daemon-/);
  } finally {
    await daemon.stop();
  }
});

test("daemon-target CLI detaches fresh runs without subscribing for events", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.start") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "detached-start-run" },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32004,
            message: `unexpected method ${request.method}`,
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync([
      "run",
      "--connect",
      listenUrl,
      "--detach",
      "--agent",
      "daemon-agent",
      "--assignment",
      "daemon-work",
    ]);
    assert.deepEqual(
      { code: result.code, signal: result.signal, stderr: result.stderr },
      { code: 0, signal: null, stderr: "" },
    );
    assert.equal(
      result.stdout,
      "task-runner: detached run detached-start-run\n" +
        'Resume later with: task-runner run --resume-run detached-start-run "..."\n' +
        "Check status with: task-runner status detached-start-run\n",
    );
    assert.deepEqual(
      requests.map((request) => request.method),
      ["runs.start"],
    );
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI detaches resume runs and supports json output", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const requests = [];
  if (wsServer.address() === null) {
    await new Promise((resolve) => wsServer.once("listening", resolve));
  }

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      requests.push(request);
      if (request.method === "runs.resume") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "detached-resume-run" },
          }),
        );
        return;
      }
      ws.send(
        JSON.stringify({
          jsonrpc: "2.0",
          id: request.id,
          error: {
            code: -32004,
            message: `unexpected method ${request.method}`,
          },
        }),
      );
    });
  });

  try {
    const result = await runCliAsync([
      "run",
      "--connect",
      listenUrl,
      "--detach",
      "--resume-run",
      "abc123",
      "--output-format",
      "json",
    ]);
    assert.deepEqual(
      { code: result.code, signal: result.signal, stderr: result.stderr },
      { code: 0, signal: null, stderr: "" },
    );
    assert.deepEqual(JSON.parse(result.stdout), {
      runId: "detached-resume-run",
      detached: true,
    });
    assert.deepEqual(
      requests.map((request) => request.method),
      ["runs.resume"],
    );
    assert.equal(requests[0].params.target, "abc123");
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI rejects --detach without daemon mode", () => {
  const failure = runCliExpectFail(["run", "--detach"]);
  assert.equal(failure.status, 3);
  assert.equal(failure.stdout, "");
  assert.match(
    failure.stderr,
    /--detach requires daemon-connected run execution \(\-\-connect or TASK_RUNNER_CONNECT\)/,
  );
});

test("daemon-target CLI rejects init --detach", () => {
  const failure = runCliExpectFail(["init", "--detach"]);
  assert.equal(failure.status, 3);
  assert.equal(failure.stdout, "");
  assert.match(failure.stderr, /init does not accept --detach/);
});

test("daemon-target CLI rejects --detach on grouped run subcommands", () => {
  const failure = runCliExpectFail(["run", "reset", "abc123", "--detach"]);
  assert.equal(failure.status, 3);
  assert.equal(failure.stdout, "");
  assert.match(
    failure.stderr,
    /run reset only supports <id-or-path>, --connect, and --output-format/,
  );
  assert.match(failure.stderr, /--detach/);
});

test("daemon-target CLI surfaces Ctrl+C cancel failures instead of exiting as a clean interrupt", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const subscriptionId = "sub-1";
  let startHandled = false;

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      if (request.method === "runs.start") {
        startHandled = true;
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "daemon-cli-run" },
          }),
        );
        return;
      }
      if (request.method === "events.subscribe") {
        assert.equal(request.params.channel, "run_timeline");
        assert.equal(request.params.runId, "daemon-cli-run");
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { subscriptionId },
          }),
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "run.timeline",
            params: {
              subscriptionId,
              runId: "daemon-cli-run",
              event: {
                type: "run_started",
                runId: "daemon-cli-run",
                agentName: "daemon-agent",
                assignmentSourcePath: null,
                assignmentPath: "/tmp/fake/assignment.md",
                name: "daemon cli",
                cwd: process.cwd(),
                sessionIndex: 1,
              },
            },
          }),
        );
        return;
      }
      if (request.method === "runs.abort") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            error: {
              code: -32004,
              message: "cancel failed",
            },
          }),
        );
        return;
      }
      if (request.method === "events.unsubscribe") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { unsubscribed: true },
          }),
        );
        return;
      }
    });
  });

  const child = spawn(
    "node",
    [
      CLI_PATH,
      "run",
      "--connect",
      listenUrl,
      "--agent",
      "daemon-agent",
      "--assignment",
      "daemon-work",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        if (startHandled) {
          resolve(undefined);
          return;
        }
        if (Date.now() - startedAt > 5_000) {
          reject(new Error("CLI did not start the daemon-target run in time"));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });

    child.kill("SIGINT");
    const result = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.deepEqual(result, { code: 1, signal: null });
    assert.match(stderr, /Ctrl\+C cancel request failed: cancel failed/);
    assert.doesNotMatch(stderr, /interrupted by user/i);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});

test("daemon-target CLI force-exits on a second Ctrl+C while daemon cancel is still pending", async () => {
  const port = await freePort();
  const listenUrl = `ws://127.0.0.1:${port}/`;
  const wsServer = new WebSocketServer({ host: "127.0.0.1", port });
  const subscriptionId = "sub-1";
  let startHandled = false;

  wsServer.on("connection", (ws) => {
    ws.on("message", (payload) => {
      const request = JSON.parse(payload.toString());
      if (request.method === "runs.start") {
        startHandled = true;
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { runId: "daemon-cli-run" },
          }),
        );
        return;
      }
      if (request.method === "events.subscribe") {
        assert.equal(request.params.channel, "run_timeline");
        assert.equal(request.params.runId, "daemon-cli-run");
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { subscriptionId },
          }),
        );
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            method: "run.timeline",
            params: {
              subscriptionId,
              runId: "daemon-cli-run",
              event: {
                type: "run_started",
                runId: "daemon-cli-run",
                agentName: "daemon-agent",
                assignmentSourcePath: null,
                assignmentPath: "/tmp/fake/assignment.md",
                name: "daemon cli",
                cwd: process.cwd(),
                sessionIndex: 1,
              },
            },
          }),
        );
        return;
      }
      if (request.method === "runs.abort") {
        return;
      }
      if (request.method === "events.unsubscribe") {
        ws.send(
          JSON.stringify({
            jsonrpc: "2.0",
            id: request.id,
            result: { unsubscribed: true },
          }),
        );
      }
    });
  });

  const child = spawn(
    "node",
    [
      CLI_PATH,
      "run",
      "--connect",
      listenUrl,
      "--agent",
      "daemon-agent",
      "--assignment",
      "daemon-work",
    ],
    {
      cwd: process.cwd(),
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });

  try {
    await new Promise((resolve, reject) => {
      const startedAt = Date.now();
      const poll = () => {
        if (startHandled) {
          resolve(undefined);
          return;
        }
        if (Date.now() - startedAt > 5_000) {
          reject(new Error("CLI did not start the daemon-target run in time"));
          return;
        }
        setTimeout(poll, 25);
      };
      poll();
    });

    child.kill("SIGINT");
    await new Promise((resolve) => setTimeout(resolve, 50));
    child.kill("SIGINT");
    const result = await new Promise((resolve) =>
      child.once("exit", (code, signal) => resolve({ code, signal })),
    );
    assert.deepEqual(result, { code: 130, signal: null });
    assert.match(stderr, /requesting daemon cancel/);
    assert.match(stderr, /forced exit/);
  } finally {
    for (const client of wsServer.clients) {
      client.terminate();
    }
    await new Promise((resolve) => wsServer.close(() => resolve()));
  }
});
