import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../apps/cli/dist/cli/parse-args.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { ResumeError, resolveResumeTarget } from "../packages/core/dist/core/run/manifest.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { setTaskStatusesForPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const NAMED_AGENT = `---
schemaVersion: 1
name: named
backend: claude
---
Agent role.
`;

const PI_NAMED_AGENT = `---
schemaVersion: 1
name: named-pi
backend: pi
model: openai/gpt-5.4
---
Agent role.
`;

const BASIC_ASSIGNMENT = `---
schemaVersion: 1
name: named-work
maxRetries: 1
tasks:
  - id: t1
    title: First
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-runname-"));
}

function writeAgent(baseDir, name, body) {
  const dir = join(baseDir, "agents", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "agent.md");
  writeFileSync(path, body);
  return path;
}

function writeAssignment(baseDir, name, body) {
  const dir = join(baseDir, "assignments", name);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "assignment.md");
  writeFileSync(path, body);
  return path;
}

function captureBackend(captured) {
  return {
    id: "mock",
    async invoke(ctx) {
      captured.name = ctx.name;
      try {
        setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
      } catch {
        // Resume/chat prompts may not expose task state in the prompt.
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        aborted: false,
        sessionId: "sess-named-1",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
  };
}

async function runIn(baseDir, opts = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("named", baseDir);
    const loadedAssignment = loadAssignmentConfig("named-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: opts.backend,
        overrides: opts.overrides,
        initialize: opts.initialize ?? false,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("run name: fresh run override persists on the manifest and reaches the backend", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", BASIC_ASSIGNMENT);

  const captured = {};
  const outcome = await runIn(dir, {
    backend: captureBackend(captured),
    overrides: { name: "Nightly cleanup" },
  });

  assert.equal(captured.name, "Nightly cleanup");
  assert.equal(outcome.manifest.name, "Nightly cleanup");
  assert.equal(outcome.manifest.resetSeed.name, "Nightly cleanup");
});

test("run name: omitted override leaves manifest null and backend name unset", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", BASIC_ASSIGNMENT);

  const captured = {};
  const outcome = await runIn(dir, {
    backend: captureBackend(captured),
  });

  assert.equal(captured.name, undefined);
  assert.equal(outcome.manifest.name, null);
  assert.equal(outcome.manifest.resetSeed.name, null);
});

test("run name: persists across resume from the manifest", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", BASIC_ASSIGNMENT);

  const first = await runIn(dir, {
    backend: captureBackend({}),
    overrides: { name: "Nightly cleanup" },
  });
  assert.equal(first.manifest.name, "Nightly cleanup");

  const captured = {};
  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(first.runId, dir);
    const loaded = loadAgentConfig("named", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const second = await runAgent({
        loaded,
        cliVars: {},
        backend: captureBackend(captured),
        resume: target,
        overrides: { message: "follow up" },
      });
      assert.equal(captured.name, "Nightly cleanup");
      assert.equal(second.manifest.name, "Nightly cleanup");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("run name: pi backend receives the persisted name on fresh run and resume", async () => {
  const dir = tempDir();
  writeAgent(dir, "named-pi", PI_NAMED_AGENT);
  writeAssignment(dir, "named-work", BASIC_ASSIGNMENT);

  const firstCaptured = {};
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("named-pi", dir);
    const loadedAssignment = loadAssignmentConfig("named-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const first = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: captureBackend(firstCaptured),
        overrides: { name: "Pi named run" },
      });
      assert.equal(firstCaptured.name, "Pi named run");
      const target = resolveResumeTarget(first.runId, dir);
      const resumedCaptured = {};
      await runAgent({
        loaded,
        cliVars: {},
        backend: captureBackend(resumedCaptured),
        resume: target,
        overrides: { message: "resume follow-up" },
      });
      assert.equal(resumedCaptured.name, "Pi named run");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("run name: init persists the name and execute-after-init replays it", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", BASIC_ASSIGNMENT);

  const init = await runIn(dir, {
    backend: {
      id: "mock",
      async invoke() {
        throw new Error("backend should not be invoked during init");
      },
    },
    overrides: { name: "Init-time name" },
    initialize: true,
  });
  assert.equal(init.manifest.name, "Init-time name");

  const captured = {};
  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(init.runId, dir);
    const loaded = loadAgentConfig("named", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await runAgent({
        loaded,
        cliVars: {},
        backend: captureBackend(captured),
        resume: target,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
  assert.equal(captured.name, "Init-time name");
});

test("run name: parseArgs accepts --name", () => {
  const parsed = parseArgs(["node", "task-runner", "run", "--agent", "x", "--name", "my-run"]);
  assert.equal(parsed.name, "my-run");
});

test("run name: parseArgs rejects empty --name", () => {
  assert.throws(
    () => parseArgs(["node", "task-runner", "run", "--agent", "x", "--name", ""]),
    /--name cannot be empty/,
  );
});

test("run name: regular resume rejects --name", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", BASIC_ASSIGNMENT);

  const first = await runIn(dir, {
    backend: captureBackend({}),
    overrides: { name: "Resume target" },
  });

  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(first.runId, dir);
    const loaded = loadAgentConfig("named", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(
        () =>
          runAgent({
            loaded,
            cliVars: {},
            backend: captureBackend({}),
            resume: target,
            overrides: { name: "new name", message: "follow up" },
          }),
        (err) => {
          assert.ok(err instanceof ResumeError);
          assert.match(err.message, /--name cannot be combined with --resume-run/);
          return true;
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("run name: execute-after-init rejects --name", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", BASIC_ASSIGNMENT);

  const init = await runIn(dir, {
    backend: {
      id: "mock",
      async invoke() {
        throw new Error("backend should not be invoked during init");
      },
    },
    initialize: true,
  });

  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(init.runId, dir);
    const loaded = loadAgentConfig("named", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(
        () =>
          runAgent({
            loaded,
            cliVars: {},
            backend: captureBackend({}),
            resume: target,
            overrides: { name: "override-via-resume" },
          }),
        (err) => {
          assert.ok(err instanceof ResumeError);
          assert.match(err.message, /--name cannot be combined with --resume-run/);
          return true;
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});
