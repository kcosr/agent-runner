import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { sharedRuntimeEnv, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const CLI_PATH = resolvePath(new URL("../apps/cli/dist/cli.js", import.meta.url).pathname);

const AGENT = `---
schemaVersion: 1
name: attachment-cmd-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: attachment-cmd-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-attachmentcmd-"));
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

function writeBundle(baseDir) {
  writeAgent(baseDir, "attachment-cmd-agent", AGENT);
  writeAssignment(baseDir, "attachment-cmd-work", ASSIGNMENT);
}

async function initRun(baseDir) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("attachment-cmd-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("attachment-cmd-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: { id: "mock", invoke: async () => ({}) },
        initialize: true,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function runCli(args, opts = {}) {
  return execFileSync("node", [CLI_PATH, ...args], {
    cwd: opts.cwd ?? process.cwd(),
    env: { ...process.env, ...sharedRuntimeEnv(opts.cwd ?? process.cwd()) },
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

function readManifest(workspaceDir) {
  return JSON.parse(readFileSync(join(workspaceDir, "run.json"), "utf8"));
}

test("attachment commands add, list, download, and remove attachments", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const sourcePath = join(dir, "notes.md");
  const downloadsDir = join(dir, "downloads");
  writeFileSync(sourcePath, "# hello\n");
  mkdirSync(downloadsDir);

  const addOutput = runCli(
    [
      "attachment",
      "add",
      outcome.runId,
      sourcePath,
      "--name",
      "notes copy.md",
      "--mime-type",
      "text/plain",
    ],
    { cwd: dir },
  );
  assert.match(addOutput, /added attachment att-[^ ]+ "notes copy\.md"/);

  const manifest = readManifest(outcome.workspaceDir);
  assert.equal(manifest.attachments.length, 1);
  const [attachment] = manifest.attachments;
  assert.equal(attachment.name, "notes copy.md");
  assert.equal(attachment.mimeType, "text/plain");

  const listed = JSON.parse(
    runCli(["attachment", "list", outcome.runId, "--output-format", "json"], { cwd: dir }),
  );
  assert.equal(listed.length, 1);
  assert.equal(listed[0].id, attachment.id);

  const downloaded = runCli(
    ["attachment", "download", outcome.runId, attachment.id, downloadsDir],
    { cwd: dir },
  );
  assert.match(downloaded, new RegExp(`downloaded attachment ${attachment.id}`));
  assert.equal(readFileSync(join(downloadsDir, "notes copy.md"), "utf8"), "# hello\n");

  const removed = JSON.parse(
    runCli(["attachment", "remove", outcome.runId, attachment.id, "--output-format", "json"], {
      cwd: dir,
    }),
  );
  assert.equal(removed.changed, true);
  assert.equal(removed.attachmentId, attachment.id);
  assert.match(runCli(["attachment", "list", outcome.runId], { cwd: dir }), /No attachments\./);
});

test("attachment download rejects an existing destination path", async () => {
  const dir = tempDir();
  writeBundle(dir);
  const outcome = await initRun(dir);
  const sourcePath = join(dir, "notes.md");
  const existingPath = join(dir, "existing.md");
  writeFileSync(sourcePath, "# hello\n");
  writeFileSync(existingPath, "already here\n");

  runCli(["attachment", "add", outcome.runId, sourcePath], { cwd: dir });
  const [attachment] = readManifest(outcome.workspaceDir).attachments;

  const result = runCliExpectFail(
    ["attachment", "download", outcome.runId, attachment.id, existingPath],
    { cwd: dir },
  );
  assert.equal(result.status, 3);
  assert.match(result.stderr, /destination file .*existing\.md already exists/);
});
