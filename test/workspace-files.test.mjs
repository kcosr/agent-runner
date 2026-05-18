import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { toHttpError } from "../apps/cli/dist/daemon/http-errors.js";
import {
  getWorkspaceFile,
  getWorkspaceFileList,
  getWorkspaceFileSearch,
} from "../packages/core/dist/app/service.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import {
  MAX_WORKSPACE_FILE_BYTES,
  MAX_WORKSPACE_LIST_ENTRIES,
  MAX_WORKSPACE_SEARCH_RESULTS,
} from "../packages/core/dist/contracts/workspace-files.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import {
  WorkspaceFileError,
  WorkspaceFileInvalidPathError,
  WorkspaceFileNotFoundError,
} from "../packages/core/dist/core/run/workspace-files.js";
import { withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const AGENT = `---
schemaVersion: 1
name: workspace-file-agent
backend: passive
---
Workspace file test agent.
`;

const ASSIGNMENT = `---
schemaVersion: 1
name: workspace-file-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Workspace file test assignment.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-workspace-files-"));
}

function writeBundle(baseDir) {
  const agentDir = join(baseDir, "agents", "workspace-file-agent");
  const assignmentDir = join(baseDir, "assignments", "workspace-file-work");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(assignmentDir, { recursive: true });
  writeFileSync(join(agentDir, "agent.md"), AGENT);
  writeFileSync(join(assignmentDir, "assignment.md"), ASSIGNMENT);
}

async function initRun(baseDir) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("workspace-file-agent", baseDir);
    const loadedAssignment = loadAssignmentConfig("workspace-file-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        parentRunId: null,
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

test("workspace file service lists, searches, and reads cwd-relative files", async () => {
  const dir = tempDir();
  writeBundle(dir);
  mkdirSync(join(dir, "docs"));
  mkdirSync(join(dir, ".git"));
  mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, ".env"), "TOKEN=secret\n");
  writeFileSync(join(dir, ".git", "guide.md"), "# Hidden guide\n");
  writeFileSync(join(dir, ".gitignore"), "dist\n");
  writeFileSync(join(dir, "docs", "guide.md"), "# Guide\n\nHello workspace.\n");
  writeFileSync(join(dir, "node_modules", "pkg", "guide.ts"), "export const hidden = true;\n");
  writeFileSync(join(dir, "src", "main.ts"), "export const value = 1;\n");
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    const root = getWorkspaceFileList(outcome.runId);
    assert.equal(root.runId, outcome.runId);
    assert.equal(root.cwd, dir);
    assert.equal(root.path, "");
    assert.equal(root.parentPath, null);
    assert.equal(root.maxEntries, MAX_WORKSPACE_LIST_ENTRIES);
    assert.equal(root.truncated, false);
    const rootKinds = new Map(root.entries.map((entry) => [entry.name, entry.kind]));
    assert.equal(rootKinds.get("agents"), "directory");
    assert.equal(rootKinds.get("assignments"), "directory");
    assert.equal(rootKinds.get("docs"), "directory");
    assert.equal(rootKinds.get("src"), "directory");
    const rootTextSupport = new Map(root.entries.map((entry) => [entry.name, entry.supportedText]));
    assert.equal(rootTextSupport.get(".env"), true);
    assert.equal(rootTextSupport.get(".gitignore"), true);

    const docs = getWorkspaceFileList(outcome.runId, { path: "docs" });
    assert.equal(docs.parentPath, "");
    assert.deepEqual(
      docs.entries.map((entry) => entry.path),
      ["docs/guide.md"],
    );
    assert.equal(docs.entries[0].supportedText, true);
    assert.equal(docs.entries[0].markdown, true);

    const search = await getWorkspaceFileSearch(outcome.runId, { query: "guide" });
    assert.equal(search.maxResults, MAX_WORKSPACE_SEARCH_RESULTS);
    assert.deepEqual(
      search.matches.map((entry) => entry.path),
      [".git/guide.md", "docs/guide.md"],
    );

    const envFile = getWorkspaceFile(outcome.runId, { path: ".env" });
    assert.equal(envFile.mediaType, "text/plain");
    assert.equal(envFile.text, "TOKEN=secret\n");

    const file = getWorkspaceFile(outcome.runId, { path: "docs/guide.md" });
    assert.equal(file.mediaType, "text/markdown");
    assert.equal(file.markdown, true);
    assert.equal(file.maxBytes, MAX_WORKSPACE_FILE_BYTES);
    assert.equal(file.text, "# Guide\n\nHello workspace.\n");
  });
});

test("workspace file service rejects traversal, missing paths, outside symlinks, binary, and oversize reads", async () => {
  const dir = tempDir();
  const outside = tempDir();
  writeBundle(dir);
  writeFileSync(join(dir, "binary.bin"), Buffer.from([0x61, 0x00, 0x62]));
  writeFileSync(join(dir, "huge.txt"), `${"x".repeat(MAX_WORKSPACE_FILE_BYTES + 1)}`);
  writeFileSync(join(outside, "secret.txt"), "secret\n");
  symlinkSync(join(dir, "missing-target.txt"), join(dir, "broken-link.txt"));
  symlinkSync(join(outside, "secret.txt"), join(dir, "secret-link.txt"));
  const outcome = await initRun(dir);

  await withSharedRuntimeEnv(dir, async () => {
    assert.throws(
      () => getWorkspaceFile(outcome.runId, { path: "../secret.txt" }),
      WorkspaceFileInvalidPathError,
    );
    assert.throws(
      () => getWorkspaceFile(outcome.runId, { path: "missing.txt" }),
      WorkspaceFileNotFoundError,
    );
    assert.throws(() => getWorkspaceFileList(outcome.runId), WorkspaceFileNotFoundError);
    await assert.rejects(
      async () => getWorkspaceFileSearch(outcome.runId, { query: "broken" }),
      WorkspaceFileNotFoundError,
    );
    assert.throws(
      () => getWorkspaceFile(outcome.runId, { path: "secret-link.txt" }),
      WorkspaceFileInvalidPathError,
    );
    assert.throws(
      () => getWorkspaceFile(outcome.runId, { path: "binary.bin" }),
      WorkspaceFileError,
    );
    assert.throws(() => getWorkspaceFile(outcome.runId, { path: "huge.txt" }), WorkspaceFileError);
  });
});

test("workspace file errors map to daemon control-plane envelopes", () => {
  assert.deepEqual(
    {
      status: toHttpError(new WorkspaceFileInvalidPathError("bad path")).status,
      code: toHttpError(new WorkspaceFileInvalidPathError("bad path")).code,
    },
    { status: 400, code: "INVALID_REQUEST" },
  );
  assert.deepEqual(
    {
      status: toHttpError(new WorkspaceFileNotFoundError("missing")).status,
      code: toHttpError(new WorkspaceFileNotFoundError("missing")).code,
    },
    { status: 404, code: "NOT_FOUND" },
  );
  assert.deepEqual(
    {
      status: toHttpError(new WorkspaceFileError("not readable")).status,
      code: toHttpError(new WorkspaceFileError("not readable")).code,
    },
    { status: 422, code: "INVALID_COMMAND" },
  );
});
