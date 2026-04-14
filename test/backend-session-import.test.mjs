import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  claudeSessionFilePath,
  encodeClaudeProjectDir,
} from "../packages/core/dist/backends/claude.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { InvalidBackendSessionError, runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { assignmentPathFromPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

// ─── claude cwd-encoding helper ─────────────────────────────────────────────

test("encodeClaudeProjectDir: replaces / and . with -", () => {
  assert.equal(encodeClaudeProjectDir("/home/kevin/foo"), "-home-kevin-foo");
  assert.equal(encodeClaudeProjectDir("/home/kevin/.claude/foo"), "-home-kevin--claude-foo");
  assert.equal(encodeClaudeProjectDir("/home/kevin/foo.bar"), "-home-kevin-foo-bar");
  assert.equal(encodeClaudeProjectDir("/tmp"), "-tmp");
});

test("claudeSessionFilePath: composes the full project file path", () => {
  const path = claudeSessionFilePath("/home/kevin/x", "abc-123");
  assert.match(path, /\.claude\/projects\/-home-kevin-x\/abc-123\.jsonl$/);
});

// ─── runAgent integration: import flow ──────────────────────────────────────

const IMPORT_AGENT = `---
schemaVersion: 1
name: import-agent
backend: claude
model: claude-sonnet-4-6
---
Agent.
`;

const CURSOR_IMPORT_AGENT = `---
schemaVersion: 1
name: cursor-import-agent
backend: cursor
model: provider/gpt-5.4
---
Agent.
`;

const IMPORT_ASSIGNMENT = `---
schemaVersion: 1
name: import-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-import-"));
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

function editStatus(content, taskId, newStatus) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${newStatus}`);
  return content.slice(0, start) + updated + content.slice(end);
}

/**
 * A backend mock with an explicit `validateSessionId` and a capture
 * surface so the test can assert what the runner forwarded.
 */
function importableBackend({ validate, captured }) {
  return {
    id: "mock",
    validateSessionId: validate,
    async invoke(ctx) {
      captured.resumeSessionId = ctx.resumeSessionId;
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
      const plan = readFileSync(absPlan, "utf8");
      writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: ctx.resumeSessionId ?? "sess-fresh",
        transcript: "ok",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };
}

async function runImportIn(baseDir, opts, agentName = "import-agent") {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(agentName, baseDir);
    const loadedAssignment = loadAssignmentConfig("import-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: opts.backend,
        bootstrapBackendSessionId: opts.bootstrapBackendSessionId,
        initialize: opts.initialize ?? false,
        overrides: opts.overrides,
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("import (run): valid session id is persisted to manifest and forwarded to first invoke", async () => {
  const dir = tempDir();
  writeAgent(dir, "import-agent", IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  const captured = {};
  let validateCalls = 0;
  const backend = importableBackend({
    captured,
    validate: async (vctx) => {
      validateCalls++;
      assert.equal(vctx.sessionId, "imported-sess-1");
      assert.ok(typeof vctx.cwd === "string" && vctx.cwd.length > 0);
      return { valid: true };
    },
  });

  const outcome = await runImportIn(dir, {
    backend,
    bootstrapBackendSessionId: "imported-sess-1",
  });

  assert.equal(validateCalls, 1, "validateSessionId is called exactly once");
  assert.equal(
    captured.resumeSessionId,
    "imported-sess-1",
    "first invoke receives the imported id",
  );
  assert.equal(outcome.manifest.backendSessionId, "imported-sess-1");
  assert.equal(outcome.exitCode, 0);
});

test("import (run): invalid session id throws InvalidBackendSessionError before workspace creation", async () => {
  const dir = tempDir();
  writeAgent(dir, "import-agent", IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  const captured = {};
  const backend = importableBackend({
    captured,
    validate: async () => ({ valid: false, reason: "session not found in storage" }),
  });

  await assert.rejects(
    () => runImportIn(dir, { backend, bootstrapBackendSessionId: "bad-id" }),
    (err) => {
      assert.ok(err instanceof InvalidBackendSessionError);
      assert.equal(err.sessionId, "bad-id");
      assert.match(err.message, /session not found in storage/);
      return true;
    },
  );
  assert.equal(captured.resumeSessionId, undefined, "backend.invoke was never called");
});

test("import (init): valid session id persists into the initialized manifest", async () => {
  const dir = tempDir();
  writeAgent(dir, "import-agent", IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  const captured = {};
  const backend = importableBackend({
    captured,
    validate: async () => ({ valid: true }),
  });

  const init = await runImportIn(dir, {
    backend,
    bootstrapBackendSessionId: "imported-sess-2",
    initialize: true,
  });
  assert.equal(init.manifest.status, "initialized");
  assert.equal(init.manifest.backendSessionId, "imported-sess-2");
  // backend.invoke must not have been called during init
  assert.equal(captured.resumeSessionId, undefined);
});

test("import (init+resume): execute-after-init forwards the imported id on first attempt", async () => {
  const dir = tempDir();
  writeAgent(dir, "import-agent", IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  const initCaptured = {};
  const initBackend = importableBackend({
    captured: initCaptured,
    validate: async () => ({ valid: true }),
  });
  const init = await runImportIn(dir, {
    backend: initBackend,
    bootstrapBackendSessionId: "imported-sess-3",
    initialize: true,
  });
  assert.equal(initCaptured.resumeSessionId, undefined, "init must not invoke");

  const target = await withSharedRuntimeEnv(dir, async () => resolveResumeTarget(init.runId, dir));
  const execCaptured = {};
  const execBackend = importableBackend({
    captured: execCaptured,
    validate: async () => {
      throw new Error("validateSessionId must not be called on resume");
    },
  });
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("import-agent", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const exec = await runAgent({
        loaded,
        cliVars: {},
        backend: execBackend,
        resume: target,
        stderr: () => {},
        stdout: () => {},
      });
      assert.equal(execCaptured.resumeSessionId, "imported-sess-3");
      assert.equal(exec.manifest.backendSessionId, "imported-sess-3");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("import: combining bootstrapBackendSessionId with resume target throws", async () => {
  const dir = tempDir();
  writeAgent(dir, "import-agent", IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  // First create a real run so we have something to resume.
  const fresh = await runImportIn(dir, {
    backend: importableBackend({ captured: {}, validate: async () => ({ valid: true }) }),
    bootstrapBackendSessionId: undefined,
  });

  const target = await withSharedRuntimeEnv(dir, async () => resolveResumeTarget(fresh.runId, dir));
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("import-agent", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(
        () =>
          runAgent({
            loaded,
            cliVars: {},
            backend: importableBackend({ captured: {}, validate: async () => ({ valid: true }) }),
            resume: target,
            bootstrapBackendSessionId: "should-be-rejected",
            overrides: { message: "follow up" },
            stderr: () => {},
            stdout: () => {},
          }),
        /backend-session-id cannot be combined with --resume-run/,
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("import: backends without validateSessionId are treated as 'always valid'", async () => {
  const dir = tempDir();
  writeAgent(dir, "import-agent", IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  const captured = {};
  const backend = {
    id: "mock-no-validate",
    // No validateSessionId at all.
    async invoke(ctx) {
      captured.resumeSessionId = ctx.resumeSessionId;
      const absPlan = assignmentPathFromPrompt(ctx.prompt);
      const plan = readFileSync(absPlan, "utf8");
      writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: ctx.resumeSessionId ?? "sess",
        transcript: "ok",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };

  const outcome = await runImportIn(dir, {
    backend,
    bootstrapBackendSessionId: "untrusted-id",
  });
  assert.equal(captured.resumeSessionId, "untrusted-id");
  assert.equal(outcome.manifest.backendSessionId, "untrusted-id");
});

test("import: cursor bootstrap session import is explicitly rejected", async () => {
  const dir = tempDir();
  writeAgent(dir, "cursor-import-agent", CURSOR_IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  await assert.rejects(
    () =>
      runImportIn(
        dir,
        {
          backend: {
            id: "cursor",
            supportsBootstrapSessionImport: false,
            async invoke() {
              throw new Error("cursor invoke should not run for rejected bootstrap import");
            },
          },
          bootstrapBackendSessionId: "cursor-chat-1",
        },
        "cursor-import-agent",
      ),
    (err) => {
      assert.ok(err instanceof InvalidBackendSessionError);
      assert.match(err.message, /cursor backend-session import is unsupported/);
      return true;
    },
  );
});

test("import: task-runner-created cursor runs reuse the captured backend session id on resume", async () => {
  const dir = tempDir();
  writeAgent(dir, "cursor-import-agent", CURSOR_IMPORT_AGENT);
  writeAssignment(dir, "import-work", IMPORT_ASSIGNMENT);

  const firstCalls = [];
  const fresh = await runImportIn(
    dir,
    {
      backend: {
        id: "cursor",
        supportsBootstrapSessionImport: false,
        async invoke(ctx) {
          firstCalls.push(ctx.resumeSessionId ?? null);
          const absPlan = assignmentPathFromPrompt(ctx.prompt);
          const plan = readFileSync(absPlan, "utf8");
          writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            aborted: false,
            sessionId: ctx.resumeSessionId ?? "cursor-sess-1",
            transcript: "ok",
            rawStdout: "",
            rawStderr: "",
          };
        },
      },
    },
    "cursor-import-agent",
  );

  assert.deepEqual(firstCalls, [null]);
  assert.equal(fresh.manifest.backendSessionId, "cursor-sess-1");

  const target = await withSharedRuntimeEnv(dir, async () => resolveResumeTarget(fresh.runId, dir));
  const secondCalls = [];
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("cursor-import-agent", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const resumed = await runAgent({
        loaded,
        cliVars: {},
        backend: {
          id: "cursor",
          supportsBootstrapSessionImport: false,
          async invoke(ctx) {
            secondCalls.push(ctx.resumeSessionId ?? null);
            const plan = readFileSync(target.manifest.assignmentPath, "utf8");
            writeFileSync(
              target.manifest.assignmentPath,
              editStatus(plan, "t1", "completed"),
              "utf8",
            );
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              aborted: false,
              sessionId: ctx.resumeSessionId ?? "unexpected-new-session",
              transcript: "ok",
              rawStdout: "",
              rawStderr: "",
            };
          },
        },
        resume: target,
        overrides: { message: "Continue" },
        stderr: () => {},
        stdout: () => {},
      });
      assert.equal(resumed.manifest.backendSessionId, "cursor-sess-1");
    } finally {
      process.chdir(originalCwd);
    }
  });

  assert.deepEqual(secondCalls, ["cursor-sess-1"]);
});
