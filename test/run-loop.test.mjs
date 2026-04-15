import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { runAgent } from "../packages/core/dist/core/run/run-loop.js";
import { createRunEventCapture } from "./helpers/run-events.mjs";
import {
  setTaskStatusesForPrompt,
  updateTasksForPrompt,
  withSharedRuntimeEnv,
} from "./helpers/runtime-paths.mjs";

const THREE_AGENT = `---
schemaVersion: 1
name: three
backend: claude
model: claude-sonnet-4-6
effort: high
---
Agent prompt.
`;

const EXPLICIT_DOT_AGENT = `---
schemaVersion: 1
name: three-dot
backend: claude
model: claude-sonnet-4-6
effort: high
cwd: .
---
Agent prompt.
`;

const EXPLICIT_RELATIVE_AGENT = `---
schemaVersion: 1
name: three-relative
backend: claude
model: claude-sonnet-4-6
effort: high
cwd: nested/worktree
---
Agent prompt.
`;

const THREE_ASSIGNMENT = `---
schemaVersion: 1
name: three-work
maxRetries: 2
tasks:
  - id: t1
    title: First
    body: Do the first thing.
  - id: t2
    title: Second
    body: Do the second thing.
  - id: t3
    title: Third
    body: Do the third thing.
---
Work on the repo. Plan at {{assignment_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-run-"));
}

function writeAgent(baseDir, name, body) {
  const agentDir = join(baseDir, "agents", name);
  mkdirSync(agentDir, { recursive: true });
  const path = join(agentDir, "agent.md");
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

function writeAgentAndAssignment(baseDir) {
  writeAgent(baseDir, "three", THREE_AGENT);
  writeAssignment(baseDir, "three-work", THREE_ASSIGNMENT);
}

async function runWithMock(baseDir, mockInvoke, overrides = {}, options = {}) {
  const backend = {
    id: "mock",
    invoke: mockInvoke,
  };
  const capture = createRunEventCapture();
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig(options.agentName ?? "three", baseDir);
    const loadedAssignment = loadAssignmentConfig(options.assignmentName ?? "three-work", baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      const outcome = await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend,
        overrides,
        callerCwd: options.callerCwd,
        emitEvent: capture.emitEvent,
      });
      return {
        outcome,
        stdout: capture.stdout(),
        stderr: capture.stderr(),
      };
    } finally {
      process.chdir(originalCwd);
    }
  });
}

test("fresh runs use callerCwd when the agent omits cwd", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);
  const callerDir = join(dir, "client-root");
  mkdirSync(callerDir, { recursive: true });

  let seenCwd;
  await runWithMock(
    dir,
    async (ctx) => {
      seenCwd = ctx.cwd;
      setTaskStatusesForPrompt(ctx.prompt, {
        t1: "completed",
        t2: "completed",
        t3: "completed",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: null,
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { callerCwd: callerDir },
  );

  assert.equal(seenCwd, callerDir);
});

test("explicit agent cwd resolves relative to callerCwd", async () => {
  const dir = tempDir();
  writeAgent(dir, "three-relative", EXPLICIT_RELATIVE_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  const callerDir = join(dir, "client-root");
  mkdirSync(join(callerDir, "nested", "worktree"), { recursive: true });

  let seenCwd;
  await runWithMock(
    dir,
    async (ctx) => {
      seenCwd = ctx.cwd;
      setTaskStatusesForPrompt(ctx.prompt, {
        t1: "completed",
        t2: "completed",
        t3: "completed",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: null,
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { agentName: "three-relative", callerCwd: callerDir },
  );

  assert.equal(seenCwd, join(callerDir, "nested", "worktree"));
});

test("explicit --cwd override beats agent cwd and callerCwd", async () => {
  const dir = tempDir();
  writeAgent(dir, "three-dot", EXPLICIT_DOT_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  const callerDir = join(dir, "client-root");
  mkdirSync(join(callerDir, "override-root"), { recursive: true });

  let seenCwd;
  await runWithMock(
    dir,
    async (ctx) => {
      seenCwd = ctx.cwd;
      setTaskStatusesForPrompt(ctx.prompt, {
        t1: "completed",
        t2: "completed",
        t3: "completed",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: null,
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    { cwd: "override-root" },
    { agentName: "three-dot", callerCwd: callerDir },
  );

  assert.equal(seenCwd, join(callerDir, "override-root"));
});

test("effort level from frontmatter is forwarded to backend", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let seenEffort;
  const { outcome } = await runWithMock(dir, async (ctx) => {
    seenEffort = ctx.effort;
    setTaskStatusesForPrompt(ctx.prompt, {
      t1: "completed",
      t2: "completed",
      t3: "completed",
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenEffort, "high");
});

test("effort override beats the frontmatter value", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let seenEffort;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenEffort = ctx.effort;
      setTaskStatusesForPrompt(ctx.prompt, {
        t1: "completed",
        t2: "completed",
        t3: "completed",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: null,
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    { effort: "low" },
  );

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenEffort, "low");
});

test("happy path: mock marks all tasks completed in one attempt → exit 0", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let invocations = 0;
  const { outcome, stdout, stderr } = await runWithMock(dir, async (ctx) => {
    invocations++;
    setTaskStatusesForPrompt(ctx.prompt, {
      t1: "completed",
      t2: "completed",
      t3: "completed",
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-abc",
      transcript: "All done.",
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(invocations, 1);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary.status, "success");
  assert.equal(outcome.summary.tasksCompleted, 3);
  assert.equal(outcome.summary.attempts, 1);
  assert.ok(stderr.includes("── attempt 1 ──"), "divider on stderr");
  assert.ok(!stdout.includes("── attempt 1 ──"), "divider not on stdout");
  assert.ok(stderr.includes("Task results:"), "summary shows task results section");
});

test("retry path: first attempt leaves one incomplete, second completes → exit 0", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let invocations = 0;
  let lastPrompt = "";
  const { outcome } = await runWithMock(dir, async (ctx) => {
    invocations++;
    lastPrompt = ctx.prompt;
    if (invocations === 1) {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed", t2: "completed" });
    } else {
      setTaskStatusesForPrompt(ctx.prompt, { t3: "completed" });
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-xyz",
      transcript: `attempt ${invocations} message`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(invocations, 2);
  assert.equal(outcome.exitCode, 0);
  assert.equal(outcome.summary.attempts, 2);
  assert.equal(outcome.attemptTranscripts.length, 2);
  assert.ok(lastPrompt.includes("Remaining tasks:"), "retry prompt should be the nudge");
  assert.ok(lastPrompt.includes("t3 (status: pending)"));
});

test("blocked path: marking one task blocked → exit 2, no further retries", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let invocations = 0;
  const { outcome } = await runWithMock(dir, async (ctx) => {
    invocations++;
    updateTasksForPrompt(ctx.prompt, {
      t1: { status: "completed" },
      t2: { status: "blocked" },
    });
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: "hit a wall",
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(invocations, 1, "should not retry when a task is blocked");
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.summary.status, "blocked");
  const blocked = outcome.summary.tasks.filter((t) => t.status === "blocked");
  assert.equal(blocked.length, 1);
  assert.equal(blocked[0].id, "t2");
});

test("exhausted path: never completes → exit 1 after maxRetries+1 attempts", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let invocations = 0;
  const { outcome } = await runWithMock(dir, async () => {
    invocations++;
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: null,
      transcript: `msg ${invocations}`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(invocations, 3, "maxRetries=2 → 3 total attempts");
  assert.equal(outcome.exitCode, 1);
  assert.equal(outcome.summary.status, "exhausted");
  assert.equal(outcome.summary.attempts, 3);
});

test("session resume: first attempt session ID passed on retry", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const seenResumeIds = [];
  let invocations = 0;
  const { outcome } = await runWithMock(dir, async (ctx) => {
    invocations++;
    seenResumeIds.push(ctx.resumeSessionId ?? null);
    if (invocations === 1) {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
    } else {
      setTaskStatusesForPrompt(ctx.prompt, {
        t1: "completed",
        t2: "completed",
        t3: "completed",
      });
    }
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "sess-12345",
      transcript: `msg ${invocations}`,
      rawStdout: "",
      rawStderr: "",
    };
  });

  assert.equal(outcome.exitCode, 0);
  assert.equal(seenResumeIds[0], null, "first attempt has no resume id");
  assert.equal(seenResumeIds[1], "sess-12345", "retry uses extracted session id");
});

test("in-run resume rejection stops the run with an error", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  let invocations = 0;
  const { outcome, stderr } = await runWithMock(
    dir,
    async (ctx) => {
      invocations++;
      // attempt 1 succeeds but leaves tasks incomplete; attempt 2 is the retry
      // that carries --resume; the mock pretends claude rejects that session
      if (invocations === 1) {
        setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          sessionId: "sess-expired",
          transcript: "got the first one",
          rawStdout: "",
          rawStderr: "",
        };
      }
      return {
        exitCode: 1,
        signal: null,
        timedOut: false,
        sessionId: null,
        transcript: null,
        rawStdout: "",
        rawStderr: "session not found",
      };
    },
    { maxRetries: 3 },
  );

  assert.equal(outcome.exitCode, 4);
  assert.equal(outcome.summary.status, "error");
  assert.equal(invocations, 2, "stops after the rejected retry");
  assert.ok(stderr.includes("backend rejected the resume session"));
});
