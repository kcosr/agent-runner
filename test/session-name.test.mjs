import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { parseArgs } from "../dist/cli/parse-args.js";
import { loadAgentConfig, loadAssignmentConfig } from "../dist/config/loader.js";
import { ResumeError, resolveResumeTarget } from "../dist/runner/manifest.js";
import { LockedFieldError, runAgent } from "../dist/runner/run-loop.js";
import { assignmentPathFromPrompt, withSharedRuntimeEnv } from "./helpers/runtime-paths.mjs";

const NAMED_AGENT = `---
schemaVersion: 1
name: named
backend: claude
---
Agent role.
`;

const NAMED_ASSIGNMENT = `---
schemaVersion: 1
name: named-work
maxRetries: 1
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
maxRetries: 1
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
maxRetries: 1
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
      try {
        const absPlan = assignmentPathFromPrompt(ctx.prompt);
        const plan = readFileSync(absPlan, "utf8");
        writeFileSync(absPlan, editStatus(plan, "t1", "completed"), "utf8");
      } catch {
        // Resume/chat prompts do not include an assignment path.
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
  return withSharedRuntimeEnv(baseDir, async () => {
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
  });
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
  withSharedRuntimeEnv(dir, () => {
    assert.throws(() => loadAssignmentConfig("empty-name-work", dir));
  });
});

test("sessionName: persists across resume from manifest, not the assignment", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "static-name-work", STATIC_NAME_ASSIGNMENT);

  const first = await runIn(dir, "named", "static-name-work", {
    backend: captureBackend({}),
  });
  assert.equal(first.manifest.sessionName, "nightly-cleanup");

  const captured = {};
  await withSharedRuntimeEnv(dir, async () => {
    // On resume the assignment is forbidden — the name must come from
    // the prior manifest.
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
        stderr: () => {},
        stdout: () => {},
      });
      assert.equal(captured.sessionName, "nightly-cleanup");
      assert.equal(second.manifest.sessionName, "nightly-cleanup");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("sessionName: parseArgs accepts --session-name", () => {
  const a = parseArgs([
    "node",
    "task-runner",
    "run",
    "--agent",
    "x",
    "--session-name",
    "my-session",
  ]);
  assert.equal(a.sessionName, "my-session");
});

test("sessionName: parseArgs rejects empty --session-name", () => {
  assert.throws(
    () => parseArgs(["node", "task-runner", "run", "--agent", "x", "--session-name", ""]),
    /--session-name cannot be empty/,
  );
});

test("sessionName: --session-name override beats assignment value", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "static-name-work", STATIC_NAME_ASSIGNMENT);

  const captured = {};
  const outcome = await runIn(dir, "named", "static-name-work", {
    backend: captureBackend(captured),
  });
  // Re-run with override
  const captured2 = {};
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("named", dir);
    const loadedAssignment = loadAssignmentConfig("static-name-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const overridden = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: captureBackend(captured2),
        overrides: { sessionName: "override-name" },
        stderr: () => {},
        stdout: () => {},
      });
      assert.equal(captured2.sessionName, "override-name");
      assert.equal(overridden.manifest.sessionName, "override-name");
    } finally {
      process.chdir(originalCwd);
    }
  });
  // Original (no override) still works
  assert.equal(outcome.manifest.sessionName, "nightly-cleanup");
});

test("sessionName: --session-name override interpolates vars", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", NAMED_ASSIGNMENT);

  const captured = {};
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("named", dir);
    const loadedAssignment = loadAssignmentConfig("named-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      const outcome = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: { repo_name: "task-runner" },
        backend: captureBackend(captured),
        overrides: { sessionName: "deploy {{repo_name}} prod" },
        stderr: () => {},
        stdout: () => {},
      });
      assert.equal(captured.sessionName, "deploy task-runner prod");
      assert.equal(outcome.manifest.sessionName, "deploy task-runner prod");
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("sessionName: lockedFields: [sessionName] rejects --session-name override", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(
    dir,
    "locked-name-work",
    `---
schemaVersion: 1
name: locked-name-work
maxRetries: 1
sessionName: fixed-name
lockedFields: [sessionName]
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("named", dir);
    const loadedAssignment = loadAssignmentConfig("locked-name-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(
        () =>
          runAgent({
            loaded,
            loadedAssignment,
            cliVars: {},
            backend: captureBackend({}),
            overrides: { sessionName: "try-to-override" },
            stderr: () => {},
            stdout: () => {},
          }),
        (err) => {
          assert.ok(err instanceof LockedFieldError);
          assert.equal(err.field, "sessionName");
          return true;
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("sessionName: execute-after-init rejects --session-name override even if NOT locked", async () => {
  // Regression guard for finding #2 of the manifest-canonical review:
  // init deliberately freezes every resolvable field, so split flow
  // `init` → `run --resume-run <id> --session-name ...` must be
  // rejected. Previously this was silently accepted and allowed
  // bypassing a locked `sessionName` via the split.
  //
  // This variant tests an UNLOCKED sessionName — the "no overrides
  // on execute-after-init" rule is stricter than the lock rule and
  // should fire regardless of whether any field is locked.
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", NAMED_ASSIGNMENT);

  let init;
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("named", dir);
    const loadedAssignment = loadAssignmentConfig("named-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
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
  });

  await withSharedRuntimeEnv(dir, async () => {
    // Resume-after-init with --session-name must throw — the rule is
    // "no overrides at all" regardless of lock state.
    const target = resolveResumeTarget(init.runId, dir);
    const loaded = loadAgentConfig("named", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(
        async () =>
          runAgent({
            loaded,
            cliVars: {},
            backend: {
              id: "mock",
              invoke: async () => {
                throw new Error("backend should not be invoked");
              },
            },
            overrides: { sessionName: "override-via-resume" },
            resume: target,
            stderr: () => {},
            stdout: () => {},
          }),
        (err) => {
          assert.ok(err instanceof ResumeError);
          assert.match(err.message, /resuming an initialized run does not accept/);
          assert.match(err.message, /--session-name/);
          return true;
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("sessionName: execute-after-init rejects --session-name override when LOCKED (belt + suspenders)", async () => {
  // Paired with the test above — this one asserts the lock path is
  // still enforced even after the stricter "no overrides at all"
  // rule. Defense in depth: checkLockedFieldsFromManifest re-checks
  // manifest.lockedFields on priorInitialized so a future addition
  // to RunOverrides can't sneak past the explicit no-overrides list.
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(
    dir,
    "locked-name-work",
    `---
schemaVersion: 1
name: locked-name-work
maxRetries: 1
sessionName: fixed-name
lockedFields: [sessionName]
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  let init;
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("named", dir);
    const loadedAssignment = loadAssignmentConfig("locked-name-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      init = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
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
  });
  assert.deepEqual(init.manifest.lockedFields, ["sessionName"]);

  await withSharedRuntimeEnv(dir, async () => {
    const target = resolveResumeTarget(init.runId, dir);
    const loaded = loadAgentConfig("named", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await assert.rejects(
        async () =>
          runAgent({
            loaded,
            cliVars: {},
            backend: {
              id: "mock",
              invoke: async () => {
                throw new Error("backend should not be invoked");
              },
            },
            overrides: { sessionName: "try-to-override" },
            resume: target,
            stderr: () => {},
            stdout: () => {},
          }),
        (err) => {
          // Either rejection is acceptable — the no-overrides rule
          // fires first, so we should see ResumeError. If that rule
          // were ever removed, the lock check would still catch it
          // (that's the defense-in-depth layer).
          assert.ok(err instanceof ResumeError || err instanceof LockedFieldError);
          return true;
        },
      );
    } finally {
      process.chdir(originalCwd);
    }
  });
});

test("sessionName: init persists the resolved name; execute-after-init replays it", async () => {
  const dir = tempDir();
  writeAgent(dir, "named", NAMED_AGENT);
  writeAssignment(dir, "named-work", NAMED_ASSIGNMENT);

  let init;
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("named", dir);
    const loadedAssignment = loadAssignmentConfig("named-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
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
  });
  assert.equal(init.manifest.sessionName, "build task-runner integration");

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
        stderr: () => {},
        stdout: () => {},
      });
    } finally {
      process.chdir(originalCwd);
    }
    assert.equal(captured.sessionName, "build task-runner integration");
  });
});
