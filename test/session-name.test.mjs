import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { resolveResumeTarget } from "../dist/runner/manifest.js";
import { runAgent } from "../dist/runner/run-loop.js";

const NAMED_AGENT = `---
schemaVersion: 1
name: named
backend: claude
maxRetries: 1
---
Agent role.
`;

const NAMED_ASSIGNMENT = `---
schemaVersion: 1
name: named-work
sessionName: build {{repo_name}} integration
vars:
  repo_name:
    type: string
    required: true
    source: cli
tasks:
  - id: t1
    title: First
---
Work.
`;

const STATIC_NAME_ASSIGNMENT = `---
schemaVersion: 1
name: static-name-work
sessionName: nightly-cleanup
tasks:
  - id: t1
    title: First
---
Work.
`;

const NO_NAME_ASSIGNMENT = `---
schemaVersion: 1
name: noname-work
tasks:
  - id: t1
    title: First
---
Work.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-sessname-"));
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

function editStatus(content, taskId, newStatus) {
  const marker = `<!-- task-id: ${taskId} -->`;
  const start = content.indexOf(marker);
  const nextMarker = content.indexOf("<!-- task-id:", start + marker.length);
  const end = nextMarker < 0 ? content.length : nextMarker;
  const section = content.slice(start, end);
  const updated = section.replace(/\*\*Status:\*\*\s*\S+/, `**Status:** ${newStatus}`);
  return content.slice(0, start) + updated + content.slice(end);
}

function captureBackend(captured) {
  return {
    id: "mock",
    async invoke(ctx) {
      captured.sessionName = ctx.sessionName;
      const match = ctx.prompt.match(/\.task-runner\/\S+?\/assignment\.md/);
      if (match) {
        const absPlan = `./${match[0]}`;
        const plan = readFileSync(absPlan, "utf8");
        writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
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

async function runIn(baseDir, agentName, assignmentName, opts = {}) {
  const loaded = loadAgentConfig(agentName, baseDir);
  const loadedAssignment = assignmentName
    ? loadAssignmentConfig(assignmentName, baseDir)
    : undefined;
  const originalCwd = process.cwd();
  process.chdir(baseDir);
  try {
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars: opts.cliVars ?? {},
      backend: opts.backend,
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
}

test("sessionName: assignment provides a static name; backend receives it", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "static-name-work", STATIC_NAME_ASSIGNMENT);

  const captured = {};
  const outcome = await runIn(dir, "named", "static-name-work", {
    backend: captureBackend(captured),
  });

  assert.equal(captured.sessionName, "nightly-cleanup");
  assert.equal(outcome.manifest.sessionName, "nightly-cleanup");
});

test("sessionName: var interpolation works ({{repo_name}})", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", NAMED_ASSIGNMENT);

  const captured = {};
  const outcome = await runIn(dir, "named", "named-work", {
    backend: captureBackend(captured),
    cliVars: { repo_name: "task-runner" },
  });

  assert.equal(captured.sessionName, "build task-runner integration");
  assert.equal(outcome.manifest.sessionName, "build task-runner integration");
});

test("sessionName: missing field means null in manifest, undefined in ctx", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "noname-work", NO_NAME_ASSIGNMENT);

  const captured = {};
  const outcome = await runIn(dir, "named", "noname-work", {
    backend: captureBackend(captured),
  });

  assert.equal(captured.sessionName, undefined);
  assert.equal(outcome.manifest.sessionName, null);
});

test("sessionName: schema rejects empty string", () => {
  const dir = tempDir();
  writeAssignment(
    dir,
    "empty-name-work",
    `---
schemaVersion: 1
name: empty-name-work
sessionName: ""
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  assert.throws(() => loadAssignmentConfig("empty-name-work", dir));
});

test("sessionName: persists across resume from manifest, not the assignment", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "static-name-work", STATIC_NAME_ASSIGNMENT);

  const first = await runIn(dir, "named", "static-name-work", {
    backend: captureBackend({}),
  });
  assert.equal(first.manifest.sessionName, "nightly-cleanup");

  // On resume the assignment is forbidden — the name must come from
  // the prior manifest.
  const target = resolveResumeTarget(first.runId, dir);
  const captured = {};
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
      stderr: () => {},
      stdout: () => {},
    });
    assert.equal(captured.sessionName, "nightly-cleanup");
    assert.equal(second.manifest.sessionName, "nightly-cleanup");
  } finally {
    process.chdir(originalCwd);
  }
});

test("sessionName: init persists the resolved name; execute-after-init replays it", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", NAMED_ASSIGNMENT);

  const loaded = loadAgentConfig("named", dir);
  const loadedAssignment = loadAssignmentConfig("named-work", dir);
  const originalCwd = process.cwd();
  process.chdir(dir);
  let init;
  try {
    init = await runAgent({
      loaded,
      loadedAssignment,
      cliVars: { repo_name: "task-runner" },
      backend: {
        id: "mock",
        invoke: async () => {
          throw new Error("backend should not be invoked during init");
        },
      },
      initialize: true,
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(init.manifest.sessionName, "build task-runner integration");

  const captured = {};
  const target = resolveResumeTarget(init.runId, dir);
  process.chdir(dir);
  try {
    await runAgent({
      loaded,
      cliVars: {},
      backend: captureBackend(captured),
      resume: target,
      stderr: () => {},
      stdout: () => {},
    });
  } finally {
    process.chdir(originalCwd);
  }
  assert.equal(captured.sessionName, "build task-runner integration");
});
