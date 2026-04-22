import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import { readStatus } from "../packages/core/dist/core/commands/service.js";
import {
  findRunManifestsById,
  resolveResumeTarget,
} from "../packages/core/dist/core/run/manifest.js";
import {
  LineageMissingError,
  LineageResolutionError,
  runAgent,
} from "../packages/core/dist/core/run/run-loop.js";
import { createRunEventCapture } from "./helpers/run-events.mjs";
import {
  resolveRunFromPrompt,
  runIdFromPrompt,
  setTaskStatusesForPrompt,
  sharedRuntimeEnv,
  updateTasksForPrompt,
  withEnv,
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

const EXPLICIT_DOT_ASSIGNMENT = `---
schemaVersion: 1
name: three-dot-work
cwd: .
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

const EXPLICIT_RELATIVE_ASSIGNMENT = `---
schemaVersion: 1
name: three-relative-work
cwd: nested/worktree
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

const CODEX_AGENT = `---
schemaVersion: 1
name: codex-agent
backend: codex
---
Codex agent prompt.
`;

const CODEX_STDIO_AGENT = `---
schemaVersion: 1
name: codex-stdio-agent
backend: codex
backendSpecific:
  codex:
    transport:
      type: stdio
---
Codex agent prompt.
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

function writeLauncher(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "launchers");
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${name}${ext}`);
  writeFileSync(path, body);
  return path;
}

function writeNamedHook(baseDir, name, body) {
  const dir = join(baseDir, "hooks", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "hook.ts"), body);
}

function writeNodeScript(baseDir, name, body) {
  const path = join(baseDir, name);
  writeFileSync(path, body);
  return path;
}

function gitTestEnv() {
  return Object.fromEntries(
    Object.entries(process.env).filter(([key]) => {
      return !key.startsWith("GIT_");
    }),
  );
}

function initGitRepo(baseDir) {
  const repoDir = join(baseDir, "repo");
  const hooksDir = join(repoDir, ".githooks-disabled");
  mkdirSync(repoDir, { recursive: true });
  const env = gitTestEnv();
  execFileSync("git", ["init", "--initial-branch=main", repoDir], { encoding: "utf8", env });
  mkdirSync(hooksDir, { recursive: true });
  execFileSync("git", ["-C", repoDir, "config", "core.hooksPath", hooksDir], {
    encoding: "utf8",
    env,
  });
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Task Runner Tests"], {
    encoding: "utf8",
    env,
  });
  execFileSync("git", ["-C", repoDir, "config", "user.email", "tests@example.com"], {
    encoding: "utf8",
    env,
  });
  writeFileSync(join(repoDir, "README.md"), "seed\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md"], { encoding: "utf8", env });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "seed"], { encoding: "utf8", env });
  return repoDir;
}

function writeAgentAndAssignment(baseDir) {
  writeAgent(baseDir, "three", THREE_AGENT);
  writeAssignment(baseDir, "three-work", THREE_ASSIGNMENT);
}

async function runWithMock(baseDir, mockInvoke, overrides = {}, options = {}) {
  const backend = {
    id: options.backendId ?? "mock",
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
        parentRunId: options.parentRunId ?? null,
        backend,
        overrides,
        callerCwd: options.callerCwd,
        execution: options.execution,
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

async function initWithOptions(baseDir, assignmentName, { cliVars = {}, parentRunId = null } = {}) {
  return withSharedRuntimeEnv(baseDir, async () => {
    const loaded = loadAgentConfig("three", baseDir);
    const loadedAssignment = loadAssignmentConfig(assignmentName, baseDir);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars,
        parentRunId,
        backend: {
          id: "claude",
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

test("fresh runs use callerCwd when the assignment omits cwd", async () => {
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

test("explicit assignment cwd resolves relative to callerCwd", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(dir, "three-relative-work", EXPLICIT_RELATIVE_ASSIGNMENT);
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
    { assignmentName: "three-relative-work", callerCwd: callerDir },
  );

  assert.equal(seenCwd, join(callerDir, "nested", "worktree"));
});

test("explicit --cwd override beats assignment cwd and callerCwd", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(dir, "three-dot-work", EXPLICIT_DOT_ASSIGNMENT);
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
    { assignmentName: "three-dot-work", callerCwd: callerDir },
  );

  assert.equal(seenCwd, join(callerDir, "override-root"));
});

test("prepare named hooks freeze resolved descriptors and prepare outputs across init and resume", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
vars:
  prepared_dir:
    type: string
    required: true
    requiredAt: prepare
hooks:
  prepare:
    - name: freeze-prepare
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  writeNamedHook(
    dir,
    "freeze-prepare",
    `export default {
  name: "freeze-prepare",
  prepare(ctx) {
    return {
      action: "continue",
      mutate: {
        run: { cwd: ctx.run.cwd + "/prepared" },
        vars: { prepared_dir: ctx.run.cwd + "/prepared" },
        state: { prepared: true },
        note: "prepared once",
      },
    };
  },
};
`,
  );

  const initialized = await runWithMock(
    dir,
    async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "session-1",
      transcript: "init",
      rawStdout: "",
      rawStderr: "",
    }),
    {},
    { assignmentName: "three-work", backendId: "claude" },
  );

  const initManifest = JSON.parse(
    readFileSync(join(initialized.outcome.workspaceDir, "run.json"), "utf8"),
  );
  assert.equal(initManifest.runtimeVars.prepared_dir, join(dir, "prepared"));
  assert.equal(initManifest.note, "prepared once");
  assert.equal(initManifest.hookState.prepared, true);
  assert.equal(initManifest.resolvedHooks[0].source.name, "freeze-prepare");
  assert.match(initManifest.resolvedHooks[0].resolvedPath, /freeze-prepare\/hook\.ts$/);

  writeNamedHook(
    dir,
    "freeze-prepare",
    `export default {
  name: "freeze-prepare",
  prepare() {
    return {
      action: "continue",
      mutate: { run: { cwd: "/different" }, vars: { prepared_dir: "/different" } },
    };
  },
};
`,
  );

  const target = withSharedRuntimeEnv(dir, () =>
    resolveResumeTarget(initialized.outcome.runId, dir),
  );
  let resumedCwd;
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("three", dir);
    const resumed = await runAgent({
      loaded,
      cliVars: {},
      backend: {
        id: "claude",
        invoke: async (ctx) => {
          resumedCwd = ctx.cwd;
          const manifestPath = join(target.workspaceDir, "run.json");
          const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
          manifest.finalTasks.t1.status = "completed";
          manifest.tasksCompleted = 1;
          writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
          return {
            exitCode: 0,
            signal: null,
            timedOut: false,
            sessionId: "session-2",
            transcript: "done",
            rawStdout: "",
            rawStderr: "",
          };
        },
      },
      resume: target,
    });
    assert.equal(resumed.manifest.runtimeVars.prepared_dir, join(dir, "prepared"));
  });

  assert.equal(resumedCwd, join(dir, "prepared"));
});

test("command builtin json prepare hooks can mutate note, pin, attachments, vars, and state", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const evidencePath = join(dir, "evidence.txt");
  writeFileSync(evidencePath, "hook evidence\n");
  const scriptPath = writeNodeScript(
    dir,
    "prepare-json-hook.mjs",
    `process.stdout.write(JSON.stringify({
  action: "continue",
  mutate: {
    note: "prepared by command",
    pinned: true,
    vars: { prepared_token: "ready" },
    state: { preparedBy: "command" },
    attachments: {
      add: [{ sourcePath: ${JSON.stringify(evidencePath)}, name: "hook-evidence.txt" }],
    },
  },
}));\n`,
  );
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
vars:
  prepared_token:
    type: string
    required: true
    requiredAt: prepare
hooks:
  prepare:
    - builtin: command
      with:
        mode: json
        command: ${JSON.stringify(process.execPath)}
        args:
          - ${JSON.stringify(scriptPath)}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" }, dir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-command-json",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { assignmentName: "three-work", backendId: "claude" },
  );

  const manifest = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
  assert.equal(manifest.note, "prepared by command");
  assert.equal(manifest.pinned, true);
  assert.equal(manifest.runtimeVars.prepared_token, "ready");
  assert.equal(manifest.hookState.preparedBy, "command");
  assert.equal(manifest.attachments.length, 1);
  assert.equal(manifest.attachments[0].name, "hook-evidence.txt");
  assert.equal(
    readFileSync(join(outcome.workspaceDir, manifest.attachments[0].relativePath), "utf8"),
    "hook evidence\n",
  );
});

test("command builtin status mode can block before attempts without invoking the backend", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const scriptPath = writeNodeScript(
    dir,
    "before-attempt-block.mjs",
    `process.stderr.write("blocked by command\\n");
process.exit(7);\n`,
  );
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
hooks:
  beforeAttempt:
    - builtin: command
      with:
        mode: status
        command: ${JSON.stringify(process.execPath)}
        args:
          - ${JSON.stringify(scriptPath)}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  let backendInvoked = false;
  const { outcome } = await runWithMock(
    dir,
    async () => {
      backendInvoked = true;
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
    { assignmentName: "three-work", backendId: "claude" },
  );

  assert.equal(backendInvoked, false);
  assert.equal(outcome.exitCode, 2);
  assert.equal(outcome.manifest.status, "blocked");
  assert.equal(outcome.manifest.hookAudits.at(-1)?.outcome, "block");
  assert.equal(outcome.manifest.hookAudits.at(-1)?.summary, "blocked by command");
});

test("command builtin json mode rejects malformed JSON hook output", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const scriptPath = writeNodeScript(
    dir,
    "prepare-bad-json.mjs",
    'process.stdout.write("{bad");\n',
  );
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
hooks:
  prepare:
    - builtin: command
      with:
        mode: json
        command: ${JSON.stringify(process.execPath)}
        args:
          - ${JSON.stringify(scriptPath)}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  await assert.rejects(
    () =>
      runWithMock(
        dir,
        async () => {
          throw new Error("backend should not run when prepare hook JSON is malformed");
        },
        {},
        { assignmentName: "three-work", backendId: "claude" },
      ),
    /malformed JSON output/,
  );
});

test("beforeAttempt hooks persist changes before invoke and afterAttempt hooks can reinvoke with a follow-up prompt", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeNamedHook(
    dir,
    "before-attempt-note",
    `export default {
  name: "before-attempt-note",
  beforeAttempt(ctx) {
    const count = (ctx.state.beforeAttemptCount ?? 0) + 1;
    return {
      action: "continue",
      mutate: {
        note: "before-attempt-" + count,
        state: { beforeAttemptCount: count },
      },
    };
  },
};
`,
  );
  writeNamedHook(
    dir,
    "reinvoke-after-attempt",
    `export default {
  name: "reinvoke-after-attempt",
  afterAttempt(ctx) {
    if ((ctx.state.afterAttemptCount ?? 0) === 0) {
      return {
        action: "reinvoke",
        followUpPrompt: "Follow up from afterAttempt hook",
        mutate: {
          note: "after-attempt-reinvoke",
          state: { afterAttemptCount: 1 },
        },
      };
    }
    return {
      action: "continue",
      mutate: {
        state: { afterAttemptCount: (ctx.state.afterAttemptCount ?? 0) + 1 },
      },
    };
  },
};
`,
  );
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
maxRetries: 2
hooks:
  beforeAttempt:
    - name: before-attempt-note
  afterAttempt:
    - name: reinvoke-after-attempt
tasks:
  - id: t1
    title: First
  - id: t2
    title: Second
---
Work.
`,
  );

  const prompts = [];
  const notesSeenByBackend = [];
  let manifestPath = null;
  let invocations = 0;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      invocations++;
      prompts.push(ctx.prompt);
      if (!manifestPath) {
        manifestPath = join(resolveRunFromPrompt(ctx.prompt, dir).workspaceDir, "run.json");
      }
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      notesSeenByBackend.push(manifest.note);
      if (invocations === 1) {
        manifest.finalTasks.t1.status = "completed";
        manifest.tasksCompleted = 1;
      } else {
        manifest.finalTasks.t1.status = "completed";
        manifest.finalTasks.t2.status = "completed";
        manifest.tasksCompleted = 2;
      }
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-after-attempt",
        transcript: `attempt ${invocations}`,
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { assignmentName: "three-work", backendId: "claude" },
  );

  assert.equal(invocations, 2);
  assert.deepEqual(notesSeenByBackend, ["before-attempt-1", "before-attempt-2"]);
  assert.equal(prompts[1], "Follow up from afterAttempt hook");
  assert.equal(outcome.manifest.note, "before-attempt-2");
  assert.equal(outcome.manifest.hookState.beforeAttemptCount, 2);
  assert.equal(outcome.manifest.hookState.afterAttemptCount, 2);
  assert.ok(
    outcome.manifest.hookAudits.some(
      (audit) => audit.phase === "afterAttempt" && audit.outcome === "reinvoke",
    ),
  );
});

test("afterExit hooks persist terminal note and task patches", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeNamedHook(
    dir,
    "after-exit-note",
    `export default {
  name: "after-exit-note",
  afterExit() {
    return {
      action: "continue",
      mutate: {
        note: "after-exit-ran",
        patchTasks: [{ taskId: "t1", notesAppend: "after-exit note" }],
        state: { afterExitRan: true },
      },
    };
  },
};
`,
  );
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
hooks:
  afterExit:
    - name: after-exit-note
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" }, dir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-after-exit",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { assignmentName: "three-work", backendId: "claude" },
  );

  const manifest = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
  assert.equal(manifest.status, "success");
  assert.equal(manifest.note, "after-exit-ran");
  assert.equal(manifest.hookState.afterExitRan, true);
  assert.equal(manifest.finalTasks.t1.notes, "after-exit note");
  assert.ok(
    manifest.hookAudits.some(
      (audit) => audit.phase === "afterExit" && audit.outcome === "continue",
    ),
  );
});

test("attempt hooks honor when.sessionIndex across retries and resumed sessions", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeNamedHook(
    dir,
    "session-zero-only",
    `export default {
  name: "session-zero-only",
  beforeAttempt(ctx) {
    return {
      action: "continue",
      mutate: {
        note: "session-" + ctx.sessionIndex,
        state: { beforeAttemptCount: (ctx.state.beforeAttemptCount ?? 0) + 1 },
      },
    };
  },
};
`,
  );
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
maxRetries: 1
hooks:
  beforeAttempt:
    - name: session-zero-only
      when:
        sessionIndex: [0]
tasks:
  - id: t1
    title: First
  - id: t2
    title: Second
---
Work.
`,
  );

  let firstSessionInvocations = 0;
  const first = await runWithMock(
    dir,
    async (ctx) => {
      firstSessionInvocations += 1;
      const run = resolveRunFromPrompt(ctx.prompt, dir);
      const manifest = JSON.parse(readFileSync(join(run.workspaceDir, "run.json"), "utf8"));
      assert.equal(manifest.note, "session-0");
      if (firstSessionInvocations === 1) {
        updateTasksForPrompt(ctx.prompt, { t1: { status: "completed" } }, dir);
      }
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-zero",
        transcript: `session 0 attempt ${firstSessionInvocations}`,
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { assignmentName: "three-work", backendId: "claude" },
  );

  assert.equal(firstSessionInvocations, 2);
  assert.equal(first.outcome.manifest.status, "exhausted");
  assert.equal(first.outcome.manifest.hookState.beforeAttemptCount, 2);

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.outcome.runId, dir));
  let resumedNoteSeen = null;
  const resumed = await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("three", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      return await runAgent({
        loaded,
        cliVars: {},
        backend: {
          id: "claude",
          invoke: async (ctx) => {
            const manifest = JSON.parse(
              readFileSync(join(target.workspaceDir, "run.json"), "utf8"),
            );
            resumedNoteSeen = manifest.note;
            manifest.finalTasks.t1.status = "completed";
            manifest.finalTasks.t2.status = "completed";
            manifest.tasksCompleted = 2;
            writeFileSync(
              join(target.workspaceDir, "run.json"),
              `${JSON.stringify(manifest, null, 2)}\n`,
            );
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              sessionId: "session-zero",
              transcript: "resumed",
              rawStdout: "",
              rawStderr: "",
            };
          },
        },
        resume: target,
        overrides: { message: "resume after exhaustion" },
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  assert.equal(resumedNoteSeen, "session-0");
  assert.equal(resumed.manifest.status, "success");
  assert.equal(resumed.manifest.hookState.beforeAttemptCount, 2);
  assert.equal(
    resumed.manifest.hookAudits.filter((audit) => audit.phase === "beforeAttempt").length,
    2,
  );
});

test("git-worktree builtin prepare hooks create worktrees and project cwd plus worktree_path", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);
  const worktreeDir = join(dir, "feature-worktree");
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
vars:
  worktree_path:
    type: string
    required: true
    requiredAt: prepare
hooks:
  prepare:
    - builtin: git-worktree
      with:
        repo: ${JSON.stringify(repoDir)}
        from: main
        branch: hooks-test
        path: ${JSON.stringify(worktreeDir)}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  let seenCwd;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenCwd = ctx.cwd;
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" }, dir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-worktree",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { assignmentName: "three-work", backendId: "claude" },
  );

  const manifest = JSON.parse(readFileSync(join(outcome.workspaceDir, "run.json"), "utf8"));
  assert.equal(seenCwd, worktreeDir);
  assert.equal(manifest.cwd, worktreeDir);
  assert.equal(manifest.runtimeVars.worktree_path, worktreeDir);
  assert.equal(readFileSync(join(worktreeDir, "README.md"), "utf8"), "seed\n");
  assert.equal(
    execFileSync("git", ["-C", worktreeDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      env: gitTestEnv(),
    }).trim(),
    "hooks-test",
  );
});

test("lineage vars resolve in authored source order, use nearest ancestors, and freeze inherited values", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "lineage-root",
    `---
schemaVersion: 1
name: lineage-root
vars:
  shared_secret:
    type: string
    required: true
    envName: LINEAGE_SECRET
    sources: [env]
  lineage_value:
    type: string
    required: true
    sources: [cli]
tasks:
  - id: t1
    title: First
---
Root.
`,
  );
  writeAssignment(
    dir,
    "lineage-middle",
    `---
schemaVersion: 1
name: lineage-middle
vars:
  shared_secret:
    type: string
    required: true
    sources: [parent]
  lineage_value:
    type: string
    required: true
    sources: [cli, parent]
tasks:
  - id: t1
    title: First
---
Middle.
`,
  );
  writeAssignment(
    dir,
    "lineage-child",
    `---
schemaVersion: 1
name: lineage-child
vars:
  shared_secret:
    type: string
    required: true
    envName: CHILD_SECRET
    sources: [cli, parent, env]
  lineage_value:
    type: string
    required: true
    envName: UNUSED_ENV
    sources: [parent, env]
  fallback_value:
    type: string
    sources: [parent]
    default: fallback
tasks:
  - id: t1
    title: Resolve vars
---
Child.
`,
  );

  const root = await withEnv({ LINEAGE_SECRET: "root-secret" }, () =>
    initWithOptions(dir, "lineage-root", {
      cliVars: { lineage_value: "root-value" },
    }),
  );
  const middle = await initWithOptions(dir, "lineage-middle", {
    cliVars: { lineage_value: "middle-value" },
    parentRunId: root.runId,
  });
  const child = await withEnv(
    { CHILD_SECRET: "child-env-secret", UNUSED_ENV: "env-fallback" },
    () =>
      initWithOptions(dir, "lineage-child", {
        cliVars: { shared_secret: "cli-wins" },
        parentRunId: middle.runId,
      }),
  );

  assert.equal(middle.manifest.runtimeVars.shared_secret, "root-secret");
  assert.equal(middle.manifest.runtimeVarSources.shared_secret.source, "parent");
  assert.equal(middle.manifest.runtimeVarSources.shared_secret.inheritedFromRunId, root.runId);

  const middleDetail = withSharedRuntimeEnv(dir, () => readStatus(middle.runId));
  assert.deepEqual(middleDetail.runtimeVars.shared_secret, {
    redacted: true,
    source: "parent",
    envName: "LINEAGE_SECRET",
    inheritedFromRunId: root.runId,
  });

  assert.equal(child.manifest.parentRunId, middle.runId);
  assert.equal(child.manifest.runtimeVars.shared_secret, "cli-wins");
  assert.equal(child.manifest.runtimeVarSources.shared_secret.source, "cli");
  assert.equal(child.manifest.runtimeVars.lineage_value, "middle-value");
  assert.equal(child.manifest.runtimeVarSources.lineage_value.source, "parent");
  assert.equal(child.manifest.runtimeVarSources.lineage_value.inheritedFromRunId, middle.runId);
  assert.equal(child.manifest.runtimeVars.fallback_value, "fallback");
  assert.equal(child.manifest.runtimeVarSources.fallback_value.source, "default");

  const middleManifestPath = join(middle.workspaceDir, "run.json");
  const mutatedMiddle = JSON.parse(readFileSync(middleManifestPath, "utf8"));
  mutatedMiddle.runtimeVars.lineage_value = "changed-after-child";
  writeFileSync(middleManifestPath, `${JSON.stringify(mutatedMiddle, null, 2)}\n`);

  const frozenChild = JSON.parse(readFileSync(join(child.workspaceDir, "run.json"), "utf8"));
  assert.equal(frozenChild.runtimeVars.lineage_value, "middle-value");
});

test("lineage vars support inherited cwd interpolation from parent worktree_path", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);
  const worktreeDir = join(dir, "lineage-worktree");
  writeAssignment(
    dir,
    "lineage-parent-worktree",
    `---
schemaVersion: 1
name: lineage-parent-worktree
vars:
  worktree_path:
    type: string
    required: true
    requiredAt: prepare
hooks:
  prepare:
    - builtin: git-worktree
      with:
        repo: ${JSON.stringify(repoDir)}
        from: main
        branch: lineage-worktree
        path: ${JSON.stringify(worktreeDir)}
tasks:
  - id: t1
    title: First
---
Parent worktree.
`,
  );
  writeAssignment(
    dir,
    "lineage-child-cwd",
    `---
schemaVersion: 1
name: lineage-child-cwd
cwd: "{{worktree_path}}"
vars:
  worktree_path:
    type: string
    required: true
    sources: [parent]
tasks:
  - id: t1
    title: Worktree {{worktree_path}}
    body: |
      Child cwd {{cwd}} worktree {{worktree_path}}
---
Child.
`,
  );

  const parent = await initWithOptions(dir, "lineage-parent-worktree");
  let seenCwd = null;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenCwd = ctx.cwd;
      const [resolved] = findRunManifestsById(runIdFromPrompt(ctx.prompt), sharedRuntimeEnv(dir));
      assert.ok(resolved, "child run manifest should exist during invoke");
      const manifestPath = join(resolved.workspaceDir, "run.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.finalTasks.t1.status = "completed";
      manifest.tasksCompleted = Object.values(manifest.finalTasks).filter(
        (task) => task.status === "completed",
      ).length;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-lineage-child",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    {
      assignmentName: "lineage-child-cwd",
      backendId: "claude",
      parentRunId: parent.runId,
    },
  );

  assert.equal(seenCwd, worktreeDir);
  assert.equal(outcome.manifest.cwd, worktreeDir);
  assert.equal(outcome.manifest.parentRunId, parent.runId);
  assert.equal(outcome.manifest.runtimeVars.worktree_path, worktreeDir);
  assert.equal(outcome.manifest.finalTasks.t1.title, `Worktree ${worktreeDir}`);
  assert.equal(
    outcome.manifest.finalTasks.t1.body.trim(),
    `Child cwd ${worktreeDir} worktree ${worktreeDir}`,
  );
});

test("lineage resolution errors when the declared parent run cannot be read", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "lineage-missing-parent",
    `---
schemaVersion: 1
name: lineage-missing-parent
vars:
  inherited_value:
    type: string
    required: true
    sources: [parent]
tasks:
  - id: t1
    title: First
---
Child.
`,
  );

  await assert.rejects(
    () =>
      initWithOptions(dir, "lineage-missing-parent", {
        parentRunId: "missing-parent",
      }),
    (error) => error instanceof LineageResolutionError && /missing-parent/.test(error.message),
  );
});

test("lineage missing errors when a required inherited var cannot be resolved", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "lineage-required-parent",
    `---
schemaVersion: 1
name: lineage-required-parent
vars:
  inherited_value:
    type: string
    required: true
    sources: [parent]
tasks:
  - id: t1
    title: First
---
Child.
`,
  );
  writeAssignment(
    dir,
    "lineage-empty-parent",
    `---
schemaVersion: 1
name: lineage-empty-parent
tasks:
  - id: t1
    title: First
---
Parent.
`,
  );

  const parent = await initWithOptions(dir, "lineage-empty-parent");
  await assert.rejects(
    () =>
      initWithOptions(dir, "lineage-required-parent", {
        parentRunId: parent.runId,
      }),
    (error) => error instanceof LineageMissingError && /inherited_value/.test(error.message),
  );
});

test("git-sync-base builtin prepare hooks rebase the current branch onto the configured base ref", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);
  const env = gitTestEnv();

  execFileSync("git", ["-C", repoDir, "checkout", "-b", "feature/hooks"], {
    encoding: "utf8",
    env,
  });
  writeFileSync(join(repoDir, "feature.txt"), "feature\n");
  execFileSync("git", ["-C", repoDir, "add", "feature.txt"], { encoding: "utf8", env });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "feature"], { encoding: "utf8", env });
  const featureHeadBefore = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env,
  }).trim();

  execFileSync("git", ["-C", repoDir, "checkout", "main"], { encoding: "utf8", env });
  writeFileSync(join(repoDir, "README.md"), "seed\nmain update\n");
  execFileSync("git", ["-C", repoDir, "add", "README.md"], { encoding: "utf8", env });
  execFileSync("git", ["-C", repoDir, "commit", "-m", "main update"], { encoding: "utf8", env });
  const mainHead = execFileSync("git", ["-C", repoDir, "rev-parse", "main"], {
    encoding: "utf8",
    env,
  }).trim();

  execFileSync("git", ["-C", repoDir, "checkout", "feature/hooks"], { encoding: "utf8", env });

  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
cwd: ${JSON.stringify(repoDir)}
hooks:
  prepare:
    - builtin: git-sync-base
      with:
        repo: ${JSON.stringify(repoDir)}
        baseRef: main
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      assert.equal(ctx.cwd, repoDir);
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" }, repoDir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-sync-base",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { assignmentName: "three-work", backendId: "claude" },
  );

  const branchName = execFileSync("git", ["-C", repoDir, "rev-parse", "--abbrev-ref", "HEAD"], {
    encoding: "utf8",
    env,
  }).trim();
  const parentOfHead = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD^"], {
    encoding: "utf8",
    env,
  }).trim();
  const featureHeadAfter = execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
    encoding: "utf8",
    env,
  }).trim();

  assert.equal(outcome.exitCode, 0);
  assert.equal(branchName, "feature/hooks");
  assert.equal(parentOfHead, mainHead);
  assert.notEqual(featureHeadAfter, featureHeadBefore);
});

test("git-sync-base builtin prepare hooks reject dirty worktrees", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);
  const env = gitTestEnv();

  execFileSync("git", ["-C", repoDir, "checkout", "-b", "feature/hooks"], {
    encoding: "utf8",
    env,
  });
  writeFileSync(join(repoDir, "dirty.txt"), "dirty\n");

  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
cwd: ${JSON.stringify(repoDir)}
hooks:
  prepare:
    - builtin: git-sync-base
      with:
        repo: ${JSON.stringify(repoDir)}
        baseRef: main
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  await assert.rejects(
    () =>
      runWithMock(
        dir,
        async () => {
          throw new Error("backend should not run when git-sync-base rejects a dirty worktree");
        },
        {},
        { assignmentName: "three-work", backendId: "claude" },
      ),
    /git-sync-base requires a clean worktree/,
  );
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

test("attempt_started events include prompt and session metadata for timeline consumers", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);

  const events = [];
  let seenPrompt;
  await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("three", dir);
    const loadedAssignment = loadAssignmentConfig("three-work", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        backend: {
          id: "mock",
          async invoke(ctx) {
            seenPrompt = ctx.prompt;
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
        },
        emitEvent: (event) => {
          events.push(event);
        },
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  const attemptStarted = events.find((event) => event.type === "attempt_started");
  assert.ok(attemptStarted, "expected attempt_started event");
  assert.equal(attemptStarted.attempt, 1);
  assert.equal(attemptStarted.sessionIndex, 0);
  assert.equal(attemptStarted.prompt, seenPrompt);
  assert.match(attemptStarted.startedAt, /^\d{4}-\d{2}-\d{2}T/);
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

test("codex embedded runs freeze frontmatter transport ahead of client env", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-stdio-agent", CODEX_STDIO_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let seenBackendSpecific;
  const { outcome } = await withEnv({ TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/" }, () =>
    runWithMock(
      dir,
      async (ctx) => {
        seenBackendSpecific = ctx.backendSpecific;
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
      { agentName: "codex-stdio-agent", backendId: "codex" },
    ),
  );

  assert.deepEqual(seenBackendSpecific, {
    codex: {
      transport: {
        type: "stdio",
      },
    },
  });
  assert.deepEqual(outcome.manifest.backendSpecific, seenBackendSpecific);
  assert.deepEqual(outcome.manifest.resetSeed.backendSpecific, seenBackendSpecific);
});

test("codex daemon runs prefer forwarded transport over daemon env", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let seenBackendSpecific;
  const { outcome } = await withEnv({ TASK_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/" }, () =>
    runWithMock(
      dir,
      async (ctx) => {
        seenBackendSpecific = ctx.backendSpecific;
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
      {
        backendSpecific: {
          codex: {
            transport: {
              type: "ws",
              url: "ws://client.example/socket",
            },
          },
        },
      },
      {
        agentName: "codex-agent",
        backendId: "codex",
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-test",
          },
        },
      },
    ),
  );

  assert.deepEqual(seenBackendSpecific, {
    codex: {
      transport: {
        type: "ws",
        url: "ws://client.example/socket",
      },
    },
  });
  assert.deepEqual(outcome.manifest.backendSpecific, seenBackendSpecific);
});

test("codex embedded runs reject malformed TASK_RUNNER_CODEX_WS_URL before freezing transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let invoked = false;
  await assert.rejects(
    withEnv({ TASK_RUNNER_CODEX_WS_URL: "https://example.com/socket" }, () =>
      runWithMock(
        dir,
        async () => {
          invoked = true;
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
        { agentName: "codex-agent", backendId: "codex" },
      ),
    ),
    /TASK_RUNNER_CODEX_WS_URL must be an absolute ws:\/\/ or wss:\/\/ URL/,
  );
  assert.equal(invoked, false);
});

test("codex connected mode mirrors embedded mode for the same websocket transport intent", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const sharedTransport = {
    codex: {
      transport: {
        type: "ws",
        url: "ws://shared.example/socket",
      },
    },
  };

  let embeddedBackendSpecific;
  const embedded = await withEnv(
    { TASK_RUNNER_CODEX_WS_URL: sharedTransport.codex.transport.url },
    () =>
      runWithMock(
        dir,
        async (ctx) => {
          embeddedBackendSpecific = ctx.backendSpecific;
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
        { agentName: "codex-agent", backendId: "codex" },
      ),
  );

  let connectedBackendSpecific;
  const connected = await withEnv({ TASK_RUNNER_CODEX_WS_URL: "ws://daemon.example/socket" }, () =>
    runWithMock(
      dir,
      async (ctx) => {
        connectedBackendSpecific = ctx.backendSpecific;
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
      {
        backendSpecific: sharedTransport,
      },
      {
        agentName: "codex-agent",
        backendId: "codex",
        execution: {
          hostMode: "daemon",
          controller: {
            kind: "daemon",
            daemonInstanceId: "daemon-test",
          },
        },
      },
    ),
  );

  assert.deepEqual(embeddedBackendSpecific, sharedTransport);
  assert.deepEqual(connectedBackendSpecific, sharedTransport);
  assert.deepEqual(connectedBackendSpecific, embeddedBackendSpecific);
  assert.deepEqual(embedded.outcome.manifest.backendSpecific, sharedTransport);
  assert.deepEqual(connected.outcome.manifest.backendSpecific, sharedTransport);
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

test("fresh runs freeze launcher precedence as override over authored agent launcher", async () => {
  const dir = tempDir();
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: ssh
args: [shared-host]
`,
  );
  writeLauncher(
    dir,
    "override-launcher",
    `schemaVersion: 1
name: override-launcher
command: env
args: [OVERRIDE=1]
`,
  );
  writeAgent(
    dir,
    "launcher-agent",
    `---
schemaVersion: 1
name: launcher-agent
backend: claude
launcher: shared
---
Agent prompt.
`,
  );

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
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
    { launcher: "override-launcher" },
    { agentName: "launcher-agent" },
  );

  assert.deepEqual(outcome.manifest.launcher, {
    kind: "prefix",
    command: "env",
    args: ["OVERRIDE=1"],
    name: "override-launcher",
    source: "named",
  });
  assert.deepEqual(outcome.manifest.resetSeed.launcher, outcome.manifest.launcher);
});

test("fresh runs keep passive and codex websocket execution on direct launcher", async () => {
  const dir = tempDir();
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: ssh
args: [shared-host]
`,
  );
  writeAgent(
    dir,
    "codex-ws-launcher-agent",
    `---
schemaVersion: 1
name: codex-ws-launcher-agent
backend: codex
launcher: shared
backendSpecific:
  codex:
    transport:
      type: ws
      url: ws://127.0.0.1:4773/
---
Agent prompt.
`,
  );

  const { outcome } = await runWithMock(
    dir,
    async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "thread-1",
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    }),
    {},
    { agentName: "codex-ws-launcher-agent", backendId: "codex" },
  );

  assert.deepEqual(outcome.manifest.launcher, {
    kind: "direct",
    name: "direct",
  });
  assert.deepEqual(outcome.manifest.resetSeed.launcher, outcome.manifest.launcher);
});

test("daemon-owned fresh runs resolve named launcher overrides on the authoritative host", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: ssh
args: [daemon-host]
`,
  );

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
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
    { launcher: "shared" },
    {
      execution: {
        hostMode: "daemon",
        controller: {
          kind: "daemon",
          daemonInstanceId: "daemon-1",
        },
      },
    },
  );

  assert.deepEqual(outcome.manifest.launcher, {
    kind: "prefix",
    command: "ssh",
    args: ["daemon-host"],
    name: "shared",
    source: "named",
  });
});
