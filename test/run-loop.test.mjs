import { strict as assert } from "node:assert";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import { codexBackend } from "../packages/core/dist/backends/codex.js";
import { BackendConfigError, loadCustomBackends } from "../packages/core/dist/backends/registry.js";
import { loadAgentConfig, loadAssignmentConfig } from "../packages/core/dist/config/loader.js";
import {
  readStatus,
  resetRun,
  setRunGroup,
  setTask,
} from "../packages/core/dist/core/commands/service.js";
import {
  findRunManifestsById,
  resolveResumeTarget,
} from "../packages/core/dist/core/run/manifest.js";
import {
  LineageMissingError,
  LineageResolutionError,
  VarResolutionError,
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
Work on the repo. Plan at {{cwd}}.
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
Work on the repo. Plan at {{cwd}}.
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
Work on the repo. Plan at {{cwd}}.
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
backendConfig:
  codex:
    transport:
      type: stdio
---
Codex agent prompt.
`;

const BACKEND_ARGS_AGENT = `---
schemaVersion: 1
name: backend-args-agent
backend: claude
backendArgs:
  claude:
    extraArgs:
      - --claude-extra
      - value
  codex:
    extraArgs:
      - --codex-extra
      - value
  passive:
    extraArgs:
      - --passive-extra
---
Backend args agent prompt.
`;

const BUILTIN_PLAN_FEATURE_PATH = resolvePath(
  new URL("../assignments/plan-feature/assignment.md", import.meta.url).pathname,
);
const REPO_ROOT = new URL("..", import.meta.url).pathname;
const BUILTIN_PLAN_IMPLEMENT_FEATURE_PATH = resolvePath(
  new URL("../assignments/plan-implement-feature/assignment.md", import.meta.url).pathname,
);
const BUILTIN_PLAN_TEMPLATE_PATH = resolvePath(
  new URL("../assignments/plan-feature/template.md", import.meta.url).pathname,
);

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-run-"));
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

function writeEnvironment(baseDir, name, body, ext = ".yaml") {
  const dir = join(baseDir, "environments");
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

function writeCustomBackend(baseDir, name, body, filename = "backend.mjs") {
  const dir = join(baseDir, "backends", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), body);
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
  execFileSync("git", ["-C", repoDir, "config", "user.name", "Agent Runner Tests"], {
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
  const backendId = options.backendId ?? "mock";
  const backend = {
    id: backendId,
    ...(options.sourcePath ? { sourcePath: options.sourcePath } : {}),
    ...(backendId === "codex" ? { resolveConfig: codexBackend.resolveConfig } : {}),
    ...(backendId === "codex" ? { launcherApplies: codexBackend.launcherApplies } : {}),
    ...(options.resolveConfig ? { resolveConfig: options.resolveConfig } : {}),
    ...(options.launcherMode ? { launcherMode: options.launcherMode } : {}),
    ...(options.validateSessionId ? { validateSessionId: options.validateSessionId } : {}),
    ...(options.supportsBootstrapSessionImport !== undefined
      ? { supportsBootstrapSessionImport: options.supportsBootstrapSessionImport }
      : {}),
    invoke: mockInvoke,
  };
  const capture = createRunEventCapture();
  return withSharedRuntimeEnv(baseDir, () =>
    withEnv(options.env ?? {}, async () => {
      const loaded = loadAgentConfig(options.agentName ?? "three", baseDir);
      const loadedAssignment = options.resume
        ? undefined
        : loadAssignmentConfig(options.assignmentName ?? "three-work", baseDir);
      const originalCwd = process.cwd();
      process.chdir(baseDir);
      try {
        const outcome = await runAgent({
          loaded,
          loadedAssignment,
          cliVars: options.cliVars ?? {},
          webVars: options.webVars ?? {},
          parentRunId: options.parentRunId ?? null,
          runGroupId: options.runGroupId ?? null,
          backend,
          overrides,
          callerCwd: options.callerCwd,
          execution: options.execution,
          resume: options.resume,
          initialize: options.initialize,
          bootstrapBackendSessionId: options.bootstrapBackendSessionId,
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
    }),
  );
}

async function initWithOptions(
  baseDir,
  assignmentName,
  { cliVars = {}, webVars = {}, parentRunId = null } = {},
) {
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
        webVars,
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

test("fresh runs freeze selected backend args on manifest, resetSeed, and invoke context", async () => {
  const dir = tempDir();
  writeAgent(dir, "backend-args-agent", BACKEND_ARGS_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  let seenArgs = null;

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenArgs = ctx.resolvedBackendArgs;
      setTaskStatusesForPrompt(ctx.prompt, {
        t1: "completed",
        t2: "completed",
        t3: "completed",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "claude-session",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { agentName: "backend-args-agent", assignmentName: "three-work", backendId: "claude" },
  );

  assert.deepEqual(seenArgs, ["--claude-extra", "value"]);
  assert.deepEqual(outcome.manifest.resolvedBackendArgs, ["--claude-extra", "value"]);
  assert.deepEqual(outcome.manifest.resetSeed.resolvedBackendArgs, ["--claude-extra", "value"]);

  const reset = (await withSharedRuntimeEnv(dir, () => resetRun(outcome.runId))).manifest;
  assert.deepEqual(reset.resolvedBackendArgs, ["--claude-extra", "value"]);
  assert.deepEqual(reset.resetSeed.resolvedBackendArgs, ["--claude-extra", "value"]);
});

test("backend override activates the matching dormant backendArgs entry", async () => {
  const dir = tempDir();
  writeAgent(dir, "backend-args-agent", BACKEND_ARGS_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  let seenArgs = null;

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenArgs = ctx.resolvedBackendArgs;
      setTaskStatusesForPrompt(ctx.prompt, {
        t1: "completed",
        t2: "completed",
        t3: "completed",
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "codex-thread",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    { backend: "codex" },
    { agentName: "backend-args-agent", assignmentName: "three-work", backendId: "codex" },
  );

  assert.deepEqual(seenArgs, ["--codex-extra", "value"]);
  assert.equal(outcome.manifest.backend, "codex");
  assert.deepEqual(outcome.manifest.resolvedBackendArgs, ["--codex-extra", "value"]);
});

test("custom backend selection freezes selected config, args, events, and resume state", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "custom-agent",
    `---
schemaVersion: 1
name: custom-agent
backend: my-agent
model: custom-model
effort: high
timeoutSec: 123
backendConfig:
  my-agent:
    mode: authored
backendArgs:
  my-agent:
    extraArgs:
      - --custom-flag
      - value
---
Custom agent.
`,
  );
  writeAssignment(
    dir,
    "custom-work",
    `---
schemaVersion: 1
name: custom-work
cwd: custom-cwd
tasks:
  - id: t1
    title: First
---
Custom work.
`,
  );

  const resolveCalls = [];
  const resolveConfig = (ctx) => {
    resolveCalls.push({
      authoredConfig: ctx.authoredConfig,
      overrideConfig: ctx.overrideConfig,
      execution: ctx.execution.hostMode,
    });
    return {
      ...ctx.authoredConfig,
      resolved: true,
    };
  };

  let firstCtx;
  const first = await runWithMock(
    dir,
    async (ctx) => {
      firstCtx = {
        cwd: ctx.cwd,
        model: ctx.model,
        effort: ctx.effort,
        timeoutSec: ctx.timeoutSec,
        backendConfig: ctx.backendConfig,
        resolvedBackendArgs: ctx.resolvedBackendArgs,
      };
      ctx.emit?.({ type: "agent_message_delta", text: "custom delta" });
      updateTasksForPrompt(ctx.prompt, {
        t1: { status: "blocked", notes: "waiting" },
      });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "custom-session",
        transcript: "custom transcript",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    {
      agentName: "custom-agent",
      assignmentName: "custom-work",
      backendId: "my-agent",
      resolveConfig,
      launcherMode: "direct",
    },
  );

  assert.deepEqual(firstCtx, {
    cwd: join(dir, "custom-cwd"),
    model: "custom-model",
    effort: "high",
    timeoutSec: 123,
    backendConfig: { mode: "authored", resolved: true },
    resolvedBackendArgs: ["--custom-flag", "value"],
  });
  assert.match(first.stdout, /custom delta/);
  assert.equal(first.outcome.manifest.backend, "my-agent");
  assert.deepEqual(first.outcome.manifest.backendConfig, { mode: "authored", resolved: true });
  assert.deepEqual(first.outcome.manifest.resetSeed.backendConfig, {
    mode: "authored",
    resolved: true,
  });
  assert.deepEqual(first.outcome.manifest.resolvedBackendArgs, ["--custom-flag", "value"]);
  assert.equal(first.outcome.manifest.backendSessionId, "custom-session");
  assert.equal(first.outcome.manifest.attemptRecords[0].transcript, "custom transcript");
  const resolveCallsAfterFirstRun = resolveCalls.length;
  assert.ok(resolveCallsAfterFirstRun >= 1);
  assert.deepEqual(resolveCalls[0].authoredConfig, { mode: "authored" });

  writeAgent(
    dir,
    "custom-agent",
    `---
schemaVersion: 1
name: custom-agent
backend: my-agent
backendConfig:
  my-agent:
    mode: changed
backendArgs:
  my-agent:
    extraArgs:
      - --changed
---
Changed custom agent.
`,
  );

  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.outcome.runId, dir));
  let resumedCtx;
  const resumed = await runWithMock(
    dir,
    async (ctx) => {
      resumedCtx = {
        resumeSessionId: ctx.resumeSessionId,
        backendConfig: ctx.backendConfig,
        resolvedBackendArgs: ctx.resolvedBackendArgs,
      };
      const manifestPath = join(target.workspaceDir, "run.json");
      const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
      manifest.finalTasks.t1.status = "completed";
      manifest.finalTasks.t1.notes = "done";
      manifest.tasksCompleted = 1;
      writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "custom-session",
        transcript: "resumed transcript",
        rawStdout: "",
        rawStderr: "",
      };
    },
    { message: "resume custom backend" },
    {
      agentName: "custom-agent",
      backendId: "my-agent",
      resolveConfig,
      launcherMode: "direct",
      resume: target,
    },
  );

  assert.deepEqual(resumedCtx, {
    resumeSessionId: "custom-session",
    backendConfig: { mode: "authored", resolved: true },
    resolvedBackendArgs: ["--custom-flag", "value"],
  });
  assert.equal(resumed.outcome.manifest.status, "success");
  assert.deepEqual(resumed.outcome.manifest.backendConfig, { mode: "authored", resolved: true });
  assert.deepEqual(resumed.outcome.manifest.resolvedBackendArgs, ["--custom-flag", "value"]);
  assert.equal(
    resolveCalls.length,
    resolveCallsAfterFirstRun,
    "resume reused frozen backendConfig",
  );
});

test("resolveConfig errors include backend name and source path", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);
  const sourcePath = join(dir, "backends", "claude", "backend.mjs");

  await assert.rejects(
    () =>
      runWithMock(
        dir,
        async () => {
          throw new Error("backend should not invoke after resolveConfig failure");
        },
        {},
        {
          backendId: "claude",
          sourcePath,
          resolveConfig() {
            throw new Error("bad config");
          },
        },
      ),
    (err) =>
      err instanceof BackendConfigError &&
      err.backendName === "claude" &&
      err.sourcePath === sourcePath &&
      /resolveConfig threw: bad config/.test(err.message),
  );
});

test("resolveConfig rejects non-persistable return values before manifest write", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);
  const sourcePath = join(dir, "backends", "claude", "backend.mjs");

  await assert.rejects(
    () =>
      runWithMock(
        dir,
        async () => {
          throw new Error("backend should not invoke after resolveConfig failure");
        },
        {},
        {
          backendId: "claude",
          sourcePath,
          resolveConfig() {
            return { when: new Date() };
          },
        },
      ),
    (err) =>
      err instanceof BackendConfigError &&
      err.backendName === "claude" &&
      err.sourcePath === sourcePath &&
      /non-persistable/.test(err.message),
  );
});

test("prepare hook backend swap re-resolves config, args, launcher, cwd, and session validation", async () => {
  const dir = tempDir();
  const evidencePath = join(dir, "custom-evidence.json");
  writeAgent(
    dir,
    "swap-agent",
    `---
schemaVersion: 1
name: swap-agent
backend: claude
backendConfig:
  custom-swap:
    mode: authored
backendArgs:
  custom-swap:
    extraArgs:
      - --custom-swap
      - value
---
Swap agent.
`,
  );
  writeAssignment(
    dir,
    "swap-work",
    `---
schemaVersion: 1
name: swap-work
hooks:
  prepare:
    - name: swap-backend
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  writeNamedHook(
    dir,
    "swap-backend",
    `export default {
  name: "swap-backend",
  prepare(ctx) {
    return {
      action: "continue",
      mutate: {
        run: {
          backend: "custom-swap",
          cwd: ctx.run.cwd + "/prepared",
          model: "hook-model",
          effort: "low",
          timeoutSec: 77,
        },
      },
    };
  },
};
`,
  );
  writeCustomBackend(
    dir,
    "custom-swap",
    `import { writeFileSync } from "node:fs";
const evidencePath = ${JSON.stringify(evidencePath)};
export default {
  id: "custom-swap",
  launcherMode: "direct",
  resolveConfig(ctx) {
    return { ...ctx.authoredConfig, resolved: true };
  },
  async validateSessionId(ctx) {
    writeFileSync(evidencePath, JSON.stringify({ phase: "validate", ctx }, null, 2));
    return { valid: true };
  },
  async invoke(ctx) {
    writeFileSync(evidencePath, JSON.stringify({ phase: "invoke", ctx }, null, 2));
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      sessionId: "custom-swap-session",
      transcript: "ok",
      rawStdout: "",
      rawStderr: ""
    };
  }
};`,
  );

  await withSharedRuntimeEnv(dir, () => loadCustomBackends(process.env));
  const result = await runWithMock(
    dir,
    async () => {
      throw new Error("initial backend should not invoke after prepare swap");
    },
    {},
    {
      agentName: "swap-agent",
      assignmentName: "swap-work",
      backendId: "claude",
    },
  );
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));

  assert.equal(evidence.phase, "invoke");
  assert.equal(evidence.ctx.cwd, join(dir, "prepared"));
  assert.equal(evidence.ctx.model, "hook-model");
  assert.equal(evidence.ctx.effort, "low");
  assert.equal(evidence.ctx.timeoutSec, 77);
  assert.deepEqual(evidence.ctx.backendConfig, { mode: "authored", resolved: true });
  assert.deepEqual(evidence.ctx.resolvedBackendArgs, ["--custom-swap", "value"]);
  assert.deepEqual(evidence.ctx.launcher, { kind: "direct", name: "direct" });
  assert.equal(result.outcome.manifest.backend, "custom-swap");
  assert.deepEqual(result.outcome.manifest.backendConfig, { mode: "authored", resolved: true });
  assert.deepEqual(result.outcome.manifest.resolvedBackendArgs, ["--custom-swap", "value"]);
  assert.deepEqual(result.outcome.manifest.launcher, { kind: "direct", name: "direct" });
});

test("prepare hook backend swap validates bootstrap session against final backend state", async () => {
  const dir = tempDir();
  const evidencePath = join(dir, "validate-evidence.json");
  writeAgent(
    dir,
    "swap-agent",
    `---
schemaVersion: 1
name: swap-agent
backend: claude
backendConfig:
  validating-swap:
    mode: authored
backendArgs:
  validating-swap:
    extraArgs:
      - --validating-swap
---
Swap agent.
`,
  );
  writeAssignment(
    dir,
    "swap-work",
    `---
schemaVersion: 1
name: swap-work
hooks:
  prepare:
    - name: swap-backend
tasks: []
---
Work.
`,
  );
  writeNamedHook(
    dir,
    "swap-backend",
    `export default {
  name: "swap-backend",
  prepare(ctx) {
    return {
      action: "continue",
      mutate: { run: { backend: "validating-swap", cwd: ctx.run.cwd + "/prepared" } },
    };
  },
};
`,
  );
  writeCustomBackend(
    dir,
    "validating-swap",
    `import { writeFileSync } from "node:fs";
const evidencePath = ${JSON.stringify(evidencePath)};
export default {
  id: "validating-swap",
  resolveConfig(ctx) {
    return { ...ctx.authoredConfig, resolved: true };
  },
  async validateSessionId(ctx) {
    writeFileSync(evidencePath, JSON.stringify(ctx, null, 2));
    return { valid: true };
  },
  async invoke() {
    return {
      exitCode: 0,
      signal: null,
      timedOut: false,
      aborted: false,
      sessionId: "validating-swap-session",
      transcript: "ok",
      rawStdout: "",
      rawStderr: ""
    };
  }
};`,
  );

  await withSharedRuntimeEnv(dir, () => loadCustomBackends(process.env));
  await runWithMock(
    dir,
    async () => {
      throw new Error("initial backend should not invoke after prepare swap");
    },
    {},
    {
      agentName: "swap-agent",
      assignmentName: "swap-work",
      backendId: "claude",
      bootstrapBackendSessionId: "imported-session",
    },
  );
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));

  assert.equal(evidence.sessionId, "imported-session");
  assert.equal(evidence.cwd, join(dir, "prepared"));
  assert.deepEqual(evidence.backendConfig, { mode: "authored", resolved: true });
  assert.deepEqual(evidence.resolvedBackendArgs, ["--validating-swap"]);
});

test("container bootstrap session validation keeps host process cwd separate from execution cwd", async () => {
  const dir = tempDir();
  const evidencePath = join(dir, "validate-evidence.json");
  writeAgent(
    dir,
    "validating-container-agent",
    `---
schemaVersion: 1
name: validating-container-agent
backend: validating-container
executionEnvironment: runtime
---
Validate container agent.
`,
  );
  writeAssignment(
    dir,
    "validating-container-work",
    `---
schemaVersion: 1
name: validating-container-work
tasks: []
---
Validate container work.
`,
  );
  writeEnvironment(
    dir,
    "runtime",
    `schemaVersion: 1
name: runtime
kind: container
mode: existing
engine: docker
container: devbox
cwd: /workspace
`,
  );

  await runWithMock(
    dir,
    async () => {
      throw new Error("validation-only initialized run should not invoke");
    },
    {},
    {
      agentName: "validating-container-agent",
      assignmentName: "validating-container-work",
      backendId: "validating-container",
      bootstrapBackendSessionId: "imported-session",
      validateSessionId: async (ctx) => {
        writeFileSync(evidencePath, JSON.stringify(ctx, null, 2));
        return { valid: true };
      },
      initialize: true,
      callerCwd: dir,
    },
  );
  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));

  assert.equal(evidence.sessionId, "imported-session");
  assert.equal(evidence.cwd, "/workspace");
  assert.equal(evidence.processCwd, dir);
});

test("post-prepare resolveConfig failure removes the fresh workspace", async () => {
  const dir = tempDir();
  writeAgent(dir, "swap-agent", THREE_AGENT.replace("name: three", "name: swap-agent"));
  writeAssignment(
    dir,
    "swap-work",
    `---
schemaVersion: 1
name: swap-work
hooks:
  prepare:
    - name: swap-backend
tasks: []
---
Work.
`,
  );
  writeNamedHook(
    dir,
    "swap-backend",
    `export default {
  name: "swap-backend",
  prepare() {
    return { action: "continue", mutate: { run: { backend: "bad-swap" } } };
  },
};
`,
  );
  writeCustomBackend(
    dir,
    "bad-swap",
    `export default {
  id: "bad-swap",
  resolveConfig() {
    throw new Error("bad swap config");
  },
  async invoke() {
    throw new Error("bad-swap should not invoke");
  }
};`,
  );

  await withSharedRuntimeEnv(dir, () => loadCustomBackends(process.env));
  await assert.rejects(
    () =>
      runWithMock(
        dir,
        async () => {
          throw new Error("initial backend should not invoke after prepare swap");
        },
        {},
        { agentName: "swap-agent", assignmentName: "swap-work", backendId: "claude" },
      ),
    /resolveConfig threw: bad swap config/,
  );

  const bucket = join(dir, "runs", "unknown");
  const remaining = existsSync(bucket) ? readdirSync(bucket) : [];
  assert.deepEqual(remaining, []);
});

test("passive backendArgs are accepted but freeze as inert empty args", async () => {
  const dir = tempDir();
  writeAgent(
    dir,
    "passive-args-agent",
    BACKEND_ARGS_AGENT.replace("name: backend-args-agent", "name: passive-args-agent").replace(
      "backend: claude",
      "backend: passive",
    ),
  );
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const outcome = await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("passive-args-agent", dir);
    const loadedAssignment = loadAssignmentConfig("three-work", dir);
    return await runAgent({
      loaded,
      loadedAssignment,
      cliVars: {},
      webVars: {},
      backend: {
        id: "passive",
        invoke: async () => {
          throw new Error("passive backend should not invoke");
        },
      },
      initialize: true,
      callerCwd: dir,
    });
  });

  assert.equal(outcome.manifest.backend, "passive");
  assert.deepEqual(outcome.manifest.resolvedBackendArgs, []);
  assert.deepEqual(outcome.manifest.resetSeed.resolvedBackendArgs, []);
});

test("resume reuses frozen backend args after agent config changes", async () => {
  const dir = tempDir();
  writeAgent(dir, "backend-args-agent", BACKEND_ARGS_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const first = await runWithMock(
    dir,
    async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "claude-session",
      transcript: "incomplete",
      rawStdout: "",
      rawStderr: "",
    }),
    {},
    { agentName: "backend-args-agent", assignmentName: "three-work", backendId: "claude" },
  );
  assert.equal(first.outcome.manifest.status, "exhausted");
  assert.deepEqual(first.outcome.manifest.resolvedBackendArgs, ["--claude-extra", "value"]);

  writeAgent(
    dir,
    "backend-args-agent",
    BACKEND_ARGS_AGENT.replace("--claude-extra", "--changed-claude-extra"),
  );
  const target = withSharedRuntimeEnv(dir, () => resolveResumeTarget(first.outcome.runId, dir));
  let seenArgs = null;
  const resumed = await withSharedRuntimeEnv(dir, async () => {
    const loaded = loadAgentConfig("backend-args-agent", dir);
    const originalCwd = process.cwd();
    process.chdir(dir);
    try {
      return await runAgent({
        loaded,
        cliVars: {},
        webVars: {},
        backend: {
          id: "claude",
          invoke: async (ctx) => {
            seenArgs = ctx.resolvedBackendArgs;
            const manifest = JSON.parse(
              readFileSync(join(target.workspaceDir, "run.json"), "utf8"),
            );
            manifest.finalTasks.t1.status = "completed";
            manifest.finalTasks.t2.status = "completed";
            manifest.finalTasks.t3.status = "completed";
            manifest.tasksCompleted = 3;
            writeFileSync(
              join(target.workspaceDir, "run.json"),
              `${JSON.stringify(manifest, null, 2)}\n`,
            );
            return {
              exitCode: 0,
              signal: null,
              timedOut: false,
              sessionId: "claude-session",
              transcript: "resumed",
              rawStdout: "",
              rawStderr: "",
            };
          },
        },
        resume: target,
        overrides: { message: "resume with frozen args" },
      });
    } finally {
      process.chdir(originalCwd);
    }
  });

  assert.deepEqual(seenArgs, ["--claude-extra", "value"]);
  assert.deepEqual(resumed.manifest.resolvedBackendArgs, ["--claude-extra", "value"]);
  assert.equal(resumed.manifest.status, "success");
});

test("runAgent freezes task-local task-transition hooks before assignment-level hooks", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "hook-order-work",
    `---
schemaVersion: 1
name: hook-order-work
hooks:
  taskTransition:
    - name: assignment-guard
tasks:
  - id: t1
    title: First
    hooks:
      - name: local-guard
  - id: t2
    title: Second
---
Work on the repo. Plan at {{cwd}}.
`,
  );
  writeNamedHook(
    dir,
    "local-guard",
    `export default {
  name: "local-guard",
  taskTransition() {
    return { accept: true };
  },
};
`,
  );
  writeNamedHook(
    dir,
    "assignment-guard",
    `export default {
  name: "assignment-guard",
  taskTransition() {
    return { accept: true };
  },
};
`,
  );

  const initialized = await initWithOptions(dir, "hook-order-work");
  const initManifest = JSON.parse(readFileSync(join(initialized.workspaceDir, "run.json"), "utf8"));
  assert.deepEqual(
    initManifest.resolvedHooks.map((descriptor) => ({
      hookId: descriptor.hookId,
      taskScopeId: descriptor.taskScopeId,
      name: descriptor.source.name,
    })),
    [
      {
        hookId: "taskTransition:task:t1:0:local-guard",
        taskScopeId: "t1",
        name: "local-guard",
      },
      {
        hookId: "taskTransition:0:assignment-guard",
        taskScopeId: null,
        name: "assignment-guard",
      },
    ],
  );
});

test("taskTransition hooks receive canonical run and assignment context", async () => {
  const dir = tempDir();
  const assignmentPath = writeAssignment(
    dir,
    "transition-context-work",
    `---
schemaVersion: 1
name: transition-context-work
hooks:
  taskTransition:
    - name: transition-context
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  const evidencePath = join(dir, "transition-context.json");
  writeAgent(dir, "three", THREE_AGENT);
  writeNamedHook(
    dir,
    "transition-context",
    `import { writeFileSync } from "node:fs";

const evidencePath = ${JSON.stringify(evidencePath)};

export default {
  name: "transition-context",
  taskTransition(ctx) {
    if ("assignmentPath" in ctx.run) {
      throw new Error("ctx.run.assignmentPath should not exist");
    }
    if ("workspacePath" in ctx.assignment) {
      throw new Error("ctx.assignment.workspacePath should not exist");
    }
    writeFileSync(evidencePath, JSON.stringify({
      workspaceDir: ctx.run.workspaceDir,
      assignmentName: ctx.assignment.name,
      assignmentSourcePath: ctx.assignment.sourcePath,
    }));
    return { accept: true };
  },
};
`,
  );

  const initialized = await initWithOptions(dir, "transition-context-work");
  await withSharedRuntimeEnv(dir, () => setTask(initialized.runId, "t1", { status: "completed" }));

  const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
  assert.equal(evidence.workspaceDir, initialized.workspaceDir);
  assert.equal(evidence.assignmentName, "transition-context-work");
  assert.equal(evidence.assignmentSourcePath, assignmentPath);
  const manifest = JSON.parse(readFileSync(join(initialized.workspaceDir, "run.json"), "utf8"));
  assert.ok(
    manifest.hookAudits.some(
      (audit) => audit.phase === "taskTransition" && audit.outcome === "accepted",
    ),
  );
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

test("run_group_id interpolates explicit assignment cwd, task text, and backend env", async () => {
  const dir = tempDir();
  const expectedCwd = join(dir, "workspaces", "shared-123", "repo");
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "group-work",
    `---
schemaVersion: 1
name: group-work
cwd: ${JSON.stringify(join(dir, "workspaces", "{{run_group_id}}", "repo"))}
tasks:
  - id: t1
    title: Group {{run_group_id}}
    body: Work in {{cwd}} for {{run_id}}.
---
Assignment group {{run_group_id}} cwd {{cwd}}.
`,
  );

  let seenCwd;
  let seenEnv;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenCwd = ctx.cwd;
      seenEnv = ctx.env;
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-group",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    {
      assignmentName: "group-work",
      runGroupId: "shared-123",
      env: {
        AGENT_RUNNER_RUN_ID: "stale-run",
        AGENT_RUNNER_RUN_GROUP_ID: "stale-group",
        AGENT_RUNNER_CWD: "stale-cwd",
      },
    },
  );

  assert.equal(outcome.manifest.runGroupId, "shared-123");
  assert.equal(outcome.manifest.cwd, expectedCwd);
  assert.equal(seenCwd, expectedCwd);
  assert.equal(outcome.manifest.finalTasks.t1.title, "Group shared-123");
  assert.equal(outcome.manifest.finalTasks.t1.body, `Work in ${expectedCwd} for ${outcome.runId}.`);
  assert.ok(outcome.manifest.brief.includes(`Assignment group shared-123 cwd ${expectedCwd}.`));
  assert.equal(seenEnv.AGENT_RUNNER_RUN_ID, outcome.runId);
  assert.equal(seenEnv.AGENT_RUNNER_RUN_GROUP_ID, "shared-123");
  assert.equal(seenEnv.AGENT_RUNNER_CWD, expectedCwd);
});

test("run_group_id defaults to singleton run id for assignment cwd interpolation", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "singleton-group-work",
    `---
schemaVersion: 1
name: singleton-group-work
cwd: ${JSON.stringify(join(dir, "workspaces", "{{run_group_id}}", "repo"))}
tasks:
  - id: t1
    title: Group {{run_group_id}}
---
Work.
`,
  );

  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
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
    { assignmentName: "singleton-group-work" },
  );

  assert.equal(outcome.manifest.runGroupId, outcome.runId);
  assert.equal(outcome.manifest.cwd, join(dir, "workspaces", outcome.runId, "repo"));
  assert.equal(outcome.manifest.finalTasks.t1.title, `Group ${outcome.runId}`);
});

test("run_group_id interpolates fresh --cwd overrides", async () => {
  const dir = tempDir();
  writeAgentAndAssignment(dir);
  const expectedCwd = join(dir, "workspaces", "cli-g1", "repo");
  let seenCwd;

  const { outcome } = await runWithMock(
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
    { cwd: join(dir, "workspaces", "{{run_group_id}}", "repo") },
    { runGroupId: "cli-g1" },
  );

  assert.equal(outcome.manifest.cwd, expectedCwd);
  assert.equal(seenCwd, expectedCwd);
});

test("command prepare hook args freeze run_group_id and cwd interpolation", async () => {
  const dir = tempDir();
  const expectedCwd = join(dir, "hook-workspaces", "hook-g1", "repo");
  mkdirSync(expectedCwd, { recursive: true });
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "hook-group-work",
    `---
schemaVersion: 1
name: hook-group-work
cwd: ${JSON.stringify(join(dir, "hook-workspaces", "{{run_group_id}}", "repo"))}
hooks:
  prepare:
    - builtin: command
      with:
        mode: status
        command: /bin/true
        args:
          - "{{run_group_id}}"
          - "{{cwd}}"
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
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
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
    { assignmentName: "hook-group-work", runGroupId: "hook-g1" },
  );

  assert.deepEqual(outcome.manifest.resolvedHooks[0].config.args, ["hook-g1", expectedCwd]);
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
    if ("assignmentPath" in ctx.run) {
      throw new Error("ctx.run.assignmentPath should not exist");
    }
    if ("workspacePath" in ctx.assignment) {
      throw new Error("ctx.assignment.workspacePath should not exist");
    }
    return {
      action: "continue",
      mutate: {
        run: { cwd: ctx.run.cwd + "/prepared" },
        vars: { prepared_dir: ctx.run.cwd + "/prepared" },
        state: {
          prepared: true,
          workspaceDir: ctx.run.workspaceDir,
          assignmentName: ctx.assignment.name,
          assignmentSourcePath: ctx.assignment.sourcePath,
        },
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
  assert.equal(initManifest.hookState.workspaceDir, initialized.outcome.workspaceDir);
  assert.equal(initManifest.hookState.assignmentName, "three-work");
  assert.equal(
    initManifest.hookState.assignmentSourcePath,
    join(dir, "assignments", "three-work", "assignment.md"),
  );
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
    if ("assignmentPath" in ctx.run) {
      throw new Error("ctx.run.assignmentPath should not exist");
    }
    if ("workspacePath" in ctx.assignment) {
      throw new Error("ctx.assignment.workspacePath should not exist");
    }
    const count = (ctx.state.beforeAttemptCount ?? 0) + 1;
    return {
      action: "continue",
      mutate: {
        note: "before-attempt-" + count,
        state: {
          beforeAttemptCount: count,
          beforeAttemptWorkspaceDir: ctx.run.workspaceDir,
          beforeAttemptAssignmentName: ctx.assignment.name,
          beforeAttemptAssignmentSourcePath: ctx.assignment.sourcePath,
        },
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
    if ("assignmentPath" in ctx.run) {
      throw new Error("ctx.run.assignmentPath should not exist");
    }
    if ("workspacePath" in ctx.assignment) {
      throw new Error("ctx.assignment.workspacePath should not exist");
    }
    if ((ctx.state.afterAttemptCount ?? 0) === 0) {
      return {
        action: "reinvoke",
        followUpPrompt: "Follow up from afterAttempt hook",
        mutate: {
          note: "after-attempt-reinvoke",
          state: {
            afterAttemptCount: 1,
            afterAttemptWorkspaceDir: ctx.run.workspaceDir,
            afterAttemptAssignmentName: ctx.assignment.name,
            afterAttemptAssignmentSourcePath: ctx.assignment.sourcePath,
          },
        },
      };
    }
    return {
      action: "continue",
      mutate: {
        state: {
          afterAttemptCount: (ctx.state.afterAttemptCount ?? 0) + 1,
          afterAttemptWorkspaceDir: ctx.run.workspaceDir,
          afterAttemptAssignmentName: ctx.assignment.name,
          afterAttemptAssignmentSourcePath: ctx.assignment.sourcePath,
        },
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
  assert.equal(outcome.manifest.hookState.beforeAttemptWorkspaceDir, outcome.workspaceDir);
  assert.equal(outcome.manifest.hookState.beforeAttemptAssignmentName, "three-work");
  assert.equal(
    outcome.manifest.hookState.beforeAttemptAssignmentSourcePath,
    join(dir, "assignments", "three-work", "assignment.md"),
  );
  assert.equal(outcome.manifest.hookState.afterAttemptWorkspaceDir, outcome.workspaceDir);
  assert.equal(outcome.manifest.hookState.afterAttemptAssignmentName, "three-work");
  assert.equal(
    outcome.manifest.hookState.afterAttemptAssignmentSourcePath,
    join(dir, "assignments", "three-work", "assignment.md"),
  );
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
  afterExit(ctx) {
    if ("assignmentPath" in ctx.run) {
      throw new Error("ctx.run.assignmentPath should not exist");
    }
    if ("workspacePath" in ctx.assignment) {
      throw new Error("ctx.assignment.workspacePath should not exist");
    }
    return {
      action: "continue",
      mutate: {
        note: "after-exit-ran",
        patchTasks: [{ taskId: "t1", notesAppend: "after-exit note" }],
        state: {
          afterExitRan: true,
          afterExitWorkspaceDir: ctx.run.workspaceDir,
          afterExitAssignmentName: ctx.assignment.name,
          afterExitAssignmentSourcePath: ctx.assignment.sourcePath,
        },
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
  assert.equal(manifest.hookState.afterExitWorkspaceDir, outcome.workspaceDir);
  assert.equal(manifest.hookState.afterExitAssignmentName, "three-work");
  assert.equal(
    manifest.hookState.afterExitAssignmentSourcePath,
    join(dir, "assignments", "three-work", "assignment.md"),
  );
  assert.equal(manifest.finalTasks.t1.notes, "after-exit note");
  assert.ok(
    manifest.hookAudits.some(
      (audit) => audit.phase === "afterExit" && audit.outcome === "continue",
    ),
  );
});

test("attempt hooks honor when.sessionIndex and when.attemptIndexInSession across retries and resumed sessions", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeNamedHook(
    dir,
    "session-zero-first-attempt-only",
    `export default {
  name: "session-zero-first-attempt-only",
  beforeAttempt(ctx) {
    return {
      action: "continue",
      mutate: {
        note: "session-" + ctx.sessionIndex + "-attempt-" + ctx.attemptIndexInSession,
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
    - name: session-zero-first-attempt-only
      when:
        sessionIndex: [0]
        attemptIndexInSession: [0]
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
      assert.equal(manifest.note, "session-0-attempt-0");
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
  assert.equal(first.outcome.manifest.hookState.beforeAttemptCount, 1);

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

  assert.equal(resumedNoteSeen, "session-0-attempt-0");
  assert.equal(resumed.manifest.status, "success");
  assert.equal(resumed.manifest.hookState.beforeAttemptCount, 1);
  assert.equal(
    resumed.manifest.hookAudits.filter((audit) => audit.phase === "beforeAttempt").length,
    1,
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
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" }, repoDir);
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

test("git-worktree builtin beforeAttempt hooks lazily create worktrees and switch cwd", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);
  const worktreeDir = join(dir, "feature-worktree-lazy");
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
cwd: ${JSON.stringify(repoDir)}
hooks:
  beforeAttempt:
    - builtin: git-worktree
      when:
        sessionIndex: [0]
        attemptIndexInSession: [0]
      with:
        repo: ${JSON.stringify(repoDir)}
        from: main
        branch: hooks-test-lazy
        path: ${JSON.stringify(worktreeDir)}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );

  assert.equal(existsSync(worktreeDir), false);

  let seenCwd;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenCwd = ctx.cwd;
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" }, repoDir);
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "session-worktree-lazy",
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
  assert.equal(existsSync(worktreeDir), true);
  assert.equal(readFileSync(join(worktreeDir, "README.md"), "utf8"), "seed\n");
  assert.equal(
    execFileSync("git", ["-C", worktreeDir, "rev-parse", "--abbrev-ref", "HEAD"], {
      encoding: "utf8",
      env: gitTestEnv(),
    }).trim(),
    "hooks-test-lazy",
  );
});

async function initBuiltInPlanFeature(baseDir, repoDir, cliVars) {
  return withEnv({ ...sharedRuntimeEnv(baseDir), AGENT_RUNNER_CONFIG_DIR: REPO_ROOT }, async () => {
    const loaded = loadAgentConfig(join(baseDir, "agents", "three", "agent.md"), baseDir);
    const loadedAssignment = loadAssignmentConfig(BUILTIN_PLAN_FEATURE_PATH);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars,
        parentRunId: null,
        backend: {
          id: "claude",
          async invoke() {
            throw new Error("backend should not be invoked during init");
          },
        },
        initialize: true,
        callerCwd: repoDir,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

async function initBuiltInPlanImplementFeature(baseDir, repoDir) {
  return withEnv({ ...sharedRuntimeEnv(baseDir), AGENT_RUNNER_CONFIG_DIR: REPO_ROOT }, async () => {
    const loaded = loadAgentConfig(join(baseDir, "agents", "three", "agent.md"), baseDir);
    const loadedAssignment = loadAssignmentConfig(BUILTIN_PLAN_IMPLEMENT_FEATURE_PATH);
    const originalCwd = process.cwd();
    process.chdir(baseDir);
    try {
      return await runAgent({
        loaded,
        loadedAssignment,
        cliVars: {},
        parentRunId: null,
        backend: {
          id: "claude",
          async invoke() {
            throw new Error("backend should not be invoked during init");
          },
        },
        initialize: true,
        callerCwd: repoDir,
      });
    } finally {
      process.chdir(originalCwd);
    }
  });
}

function filledPlanFeatureTemplateAssignment() {
  return readFileSync(BUILTIN_PLAN_TEMPLATE_PATH, "utf8")
    .replaceAll("<<KEBAB_FEATURE_SLUG>>", "template-lineage")
    .replace(/<<PLACEHOLDER_[A-Z_]+>>/g, "placeholder");
}

test("built-in plan-feature prepare hook freezes repo_root, worktree_path, and default worktree_base_ref", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);

  const initialized = await initBuiltInPlanFeature(dir, repoDir, {
    worktree_slug: "feature-slug",
  });

  assert.equal(initialized.manifest.cwd, repoDir);
  assert.equal(initialized.manifest.runtimeVars.worktree_slug, "feature-slug");
  assert.equal(initialized.manifest.runtimeVarSources.worktree_slug.source, "cli");
  assert.equal(initialized.manifest.runtimeVars.repo_root, repoDir);
  assert.equal(initialized.manifest.runtimeVarSources.repo_root.source, "hook");
  assert.equal(initialized.manifest.runtimeVars.worktree_path, join(dir, "repo-feature-slug"));
  assert.equal(initialized.manifest.runtimeVarSources.worktree_path.source, "hook");
  assert.equal(initialized.manifest.runtimeVars.worktree_base_ref, "origin/main");
  assert.equal(initialized.manifest.runtimeVarSources.worktree_base_ref.source, "default");
});

test("built-in plan-implement-feature initializes as one run without worktree lineage vars", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);

  const initialized = await initBuiltInPlanImplementFeature(dir, repoDir);

  assert.equal(initialized.manifest.cwd, repoDir);
  assert.equal(initialized.manifest.runtimeVars.worktree_slug, undefined);
  assert.equal(initialized.manifest.runtimeVars.worktree_path, undefined);
  assert.equal(initialized.manifest.runtimeVars.worktree_base_ref, undefined);
  assert.deepEqual(
    Object.values(initialized.manifest.finalTasks).map((task) => task.id),
    [
      "feature-plan/orient",
      "feature-plan/capture-feature",
      "feature-plan/survey-impact",
      "feature-plan/check-existing-code",
      "feature-plan/risks-and-tests",
      "feature-plan/contract",
      "feature-plan/surface-inventory",
      "feature-plan/produce-summary",
      "feature-plan/attach-summary",
      "feature-plan/await-user-approval",
      "feature-implement/scaffold",
      "feature-implement/implement-core",
      "feature-implement/implement-tests",
      "feature-implement/verify-surface-coverage",
      "feature-implement/docs-drift",
      "feature-implement/fresh-eyes",
      "feature-implement/check-gate",
      "feature-implement/commit",
      "feature-implement/internal-code-review",
      "feature-implement/apply-review-fixes",
      "feature-implement/self-check",
      "feature-implement/push-pr",
      "feature-implement/merge-after-approval",
    ],
  );
  assert.equal(initialized.manifest.resolvedHooks.length, 1);
  assert.equal(initialized.manifest.resolvedHooks[0].source.builtin, "require-children-success");
  assert.equal(initialized.manifest.resolvedHooks[0].phase, "taskTransition");
});

test("built-in plan-feature prepare hook preserves explicit worktree_base_ref", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);

  const initialized = await initBuiltInPlanFeature(dir, repoDir, {
    worktree_slug: "feature-slug",
    worktree_base_ref: "origin/feature/foo",
  });

  assert.equal(initialized.manifest.runtimeVars.worktree_base_ref, "origin/feature/foo");
  assert.equal(initialized.manifest.runtimeVarSources.worktree_base_ref.source, "cli");
});

test("built-in plan-feature template inherits worktree_base_ref into resolved hook configs", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(dir, "implement-template-lineage", filledPlanFeatureTemplateAssignment());
  const repoDir = initGitRepo(dir);

  const planner = await initBuiltInPlanFeature(dir, repoDir, {
    worktree_slug: "feature-slug",
    worktree_base_ref: "origin/feature/foo",
  });
  const child = await initWithOptions(dir, "implement-template-lineage", {
    parentRunId: planner.runId,
  });

  assert.equal(child.manifest.parentRunId, planner.runId);
  assert.equal(child.manifest.runtimeVars.worktree_base_ref, "origin/feature/foo");
  assert.equal(child.manifest.runtimeVarSources.worktree_base_ref.source, "parent");
  assert.equal(
    child.manifest.runtimeVarSources.worktree_base_ref.inheritedFromRunId,
    planner.runId,
  );

  const worktreeHook = child.manifest.resolvedHooks.find(
    (hook) => hook.source.builtin === "git-worktree",
  );
  assert.ok(worktreeHook);
  assert.equal(worktreeHook.config.from, "origin/feature/foo");

  const commandHooks = child.manifest.resolvedHooks.filter(
    (hook) => hook.source.builtin === "command",
  );
  assert.deepEqual(
    commandHooks.map((hook) => hook.config),
    [
      {
        mode: "status",
        command: "git",
        args: ["fetch", "origin", "--prune"],
      },
      {
        mode: "status",
        command: "git",
        args: ["merge", "--ff-only", "--", "origin/feature/foo"],
      },
    ],
  );
});

test("built-in plan-feature prepare hook rejects an empty worktree_slug", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);

  await assert.rejects(
    () =>
      initBuiltInPlanFeature(dir, repoDir, {
        worktree_slug: "",
      }),
    (error) => error instanceof Error && /non-empty worktree_slug/.test(error.message),
  );
});

test("built-in plan-feature prepare hook rejects regex-failing worktree_slug values", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  const repoDir = initGitRepo(dir);

  await assert.rejects(
    () =>
      initBuiltInPlanFeature(dir, repoDir, {
        worktree_slug: "../escape",
      }),
    (error) =>
      error instanceof Error &&
      /worktree_slug must match \[A-Za-z0-9\]\[A-Za-z0-9._-\]\*/.test(error.message),
  );
});

test("built-in plan-feature prepare hook rejects shell-unsafe worktree_base_ref values", async () => {
  const unsafeRefs = [
    "",
    "origin/feature foo",
    "origin/feature;rm",
    "origin/$(whoami)",
    "origin/feature&&main",
    "origin/feature|main",
    "origin/feature>main",
    "origin/'feature",
  ];

  for (const unsafeRef of unsafeRefs) {
    const dir = tempDir();
    writeAgent(dir, "three", THREE_AGENT);
    const repoDir = initGitRepo(dir);

    await assert.rejects(
      () =>
        initBuiltInPlanFeature(dir, repoDir, {
          worktree_slug: "feature-slug",
          worktree_base_ref: unsafeRef,
        }),
      (error) => error instanceof Error && /worktree_base_ref must match/.test(error.message),
    );
  }
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

test("web vars resolve in authored source order and reject unknown web keys", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "web-vars",
    `---
schemaVersion: 1
name: web-vars
vars:
  browser_value:
    type: string
    required: true
    sources: [web]
  precedence_value:
    type: string
    required: true
    sources: [cli, web]
tasks:
  - id: t1
    title: Resolve web vars
---
Resolve vars.
`,
  );

  const initialized = await initWithOptions(dir, "web-vars", {
    cliVars: { precedence_value: "cli-wins" },
    webVars: {
      browser_value: "from-web",
      precedence_value: "web-loses",
    },
  });

  assert.equal(initialized.manifest.runtimeVars.browser_value, "from-web");
  assert.equal(initialized.manifest.runtimeVarSources.browser_value.source, "web");
  assert.equal(initialized.manifest.runtimeVars.precedence_value, "cli-wins");
  assert.equal(initialized.manifest.runtimeVarSources.precedence_value.source, "cli");

  await assert.rejects(
    () =>
      initWithOptions(dir, "web-vars", {
        webVars: { undeclared_key: "value" },
      }),
    (error) => {
      assert.ok(error instanceof VarResolutionError);
      assert.match(error.message, /unknown web var key\(s\): undeclared_key/);
      return true;
    },
  );
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

test("lineage skips only legacy redacted parent sentinels, not arbitrary object-shaped values", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "lineage-parent-object",
    `---
schemaVersion: 1
name: lineage-parent-object
vars:
  lineage_value:
    type: string
    required: true
tasks:
  - id: t1
    title: Parent
---
Parent.
`,
  );
  writeAssignment(
    dir,
    "lineage-child-object",
    `---
schemaVersion: 1
name: lineage-child-object
vars:
  lineage_value:
    type: string
    required: true
    sources: [parent]
tasks:
  - id: t1
    title: Child
---
Child.
`,
  );

  const parent = await initWithOptions(dir, "lineage-parent-object", {
    cliVars: { lineage_value: "parent-value" },
  });
  const parentManifestPath = join(parent.workspaceDir, "run.json");
  const mutatedParent = JSON.parse(readFileSync(parentManifestPath, "utf8"));
  mutatedParent.runtimeVars.lineage_value = {
    redacted: true,
    nested: "not-a-legacy-sentinel",
  };
  writeFileSync(parentManifestPath, `${JSON.stringify(mutatedParent, null, 2)}\n`);

  await assert.rejects(
    () =>
      initWithOptions(dir, "lineage-child-object", {
        parentRunId: parent.runId,
      }),
    (error) => error instanceof VarResolutionError && /lineage_value/.test(error.message),
  );
});

test("cwd interpolation throws when required tokens remain unresolved", async () => {
  const dir = tempDir();
  writeAgent(dir, "three", THREE_AGENT);
  writeAssignment(
    dir,
    "cwd-unresolved",
    `---
schemaVersion: 1
name: cwd-unresolved
cwd: "{{worktree_path}}"
tasks:
  - id: t1
    title: First
---
Child.
`,
  );

  await assert.rejects(
    () => initWithOptions(dir, "cwd-unresolved"),
    (error) =>
      error instanceof VarResolutionError &&
      /cwd interpolation could not resolve token \{\{worktree_path\}\}/.test(error.message),
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
  assert.equal(attemptStarted.attemptNumber, 1);
  assert.equal(attemptStarted.sessionIndex, 0);
  assert.equal(attemptStarted.attemptIndexInSession, 0);
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

  let seenBackendConfig;
  const { outcome } = await withEnv(
    {
      AGENT_RUNNER_CODEX_UDS_PATH: "/tmp/ignored-codex.sock",
      AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
    },
    () =>
      runWithMock(
        dir,
        async (ctx) => {
          seenBackendConfig = ctx.backendConfig;
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

  assert.deepEqual(seenBackendConfig, {
    transport: {
      type: "stdio",
    },
  });
  assert.deepEqual(outcome.manifest.backendConfig, seenBackendConfig);
  assert.deepEqual(outcome.manifest.resetSeed.backendConfig, seenBackendConfig);
});

test("codex daemon runs prefer forwarded transport over daemon env", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let seenBackendConfig;
  const { outcome } = await withEnv(
    {
      AGENT_RUNNER_CODEX_UDS_PATH: "/tmp/daemon-env-codex.sock",
      AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
    },
    () =>
      runWithMock(
        dir,
        async (ctx) => {
          seenBackendConfig = ctx.backendConfig;
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
          backendConfig: {
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

  assert.deepEqual(seenBackendConfig, {
    transport: {
      type: "ws",
      url: "ws://client.example/socket",
    },
  });
  assert.deepEqual(outcome.manifest.backendConfig, seenBackendConfig);
});

test("codex daemon runs defer conflicting forwarded env until after authored transport precedence", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-stdio-agent", CODEX_STDIO_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let seenBackendConfig;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenBackendConfig = ctx.backendConfig;
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
      backendConfig: {
        udsPath: "/tmp/client-codex.sock",
        wsUrl: "ws://client.example/socket",
      },
    },
    {
      agentName: "codex-stdio-agent",
      backendId: "codex",
      execution: {
        hostMode: "daemon",
        controller: {
          kind: "daemon",
          daemonInstanceId: "daemon-test",
        },
      },
    },
  );

  assert.deepEqual(seenBackendConfig, {
    transport: {
      type: "stdio",
    },
  });
  assert.deepEqual(outcome.manifest.backendConfig, seenBackendConfig);
});

test("codex daemon runs ignore obsolete env-shaped backendConfig keys without higher precedence", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let seenBackendConfig;
  const { outcome } = await runWithMock(
    dir,
    async (ctx) => {
      seenBackendConfig = ctx.backendConfig;
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
      backendConfig: {
        udsPath: "/tmp/client-codex.sock",
        wsUrl: "ws://client.example/socket",
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
  );

  assert.deepEqual(seenBackendConfig, {
    transport: {
      type: "stdio",
    },
  });
  assert.deepEqual(outcome.manifest.backendConfig, seenBackendConfig);
});

test("codex embedded runs reject malformed AGENT_RUNNER_CODEX_WS_URL before freezing transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let invoked = false;
  await assert.rejects(
    withEnv({ AGENT_RUNNER_CODEX_WS_URL: "https://example.com/socket" }, () =>
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
    /codex websocket transport requires an absolute ws:\/\/ or wss:\/\/ URL/,
  );
  assert.equal(invoked, false);
});

test("codex embedded runs reject malformed AGENT_RUNNER_CODEX_UDS_PATH before freezing transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let invoked = false;
  await assert.rejects(
    withEnv({ AGENT_RUNNER_CODEX_UDS_PATH: "relative.sock" }, () =>
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
    /codex UDS transport requires an absolute socket path/,
  );
  assert.equal(invoked, false);
});

test("codex embedded runs reject conflicting Codex transport env before freezing transport", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  let invoked = false;
  await assert.rejects(
    withEnv(
      {
        AGENT_RUNNER_CODEX_UDS_PATH: "/tmp/codex.sock",
        AGENT_RUNNER_CODEX_WS_URL: "ws://127.0.0.1:4773/",
      },
      () =>
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
    /AGENT_RUNNER_CODEX_UDS_PATH and AGENT_RUNNER_CODEX_WS_URL cannot both be set/,
  );
  assert.equal(invoked, false);
});

test("codex connected mode mirrors embedded mode for the same websocket transport intent", async () => {
  const dir = tempDir();
  writeAgent(dir, "codex-agent", CODEX_AGENT);
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);

  const sharedTransport = {
    transport: {
      type: "ws",
      url: "ws://shared.example/socket",
    },
  };

  let embeddedBackendConfig;
  const embedded = await withEnv({ AGENT_RUNNER_CODEX_WS_URL: sharedTransport.transport.url }, () =>
    runWithMock(
      dir,
      async (ctx) => {
        embeddedBackendConfig = ctx.backendConfig;
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

  let connectedBackendConfig;
  const connected = await withEnv({ AGENT_RUNNER_CODEX_WS_URL: "ws://daemon.example/socket" }, () =>
    runWithMock(
      dir,
      async (ctx) => {
        connectedBackendConfig = ctx.backendConfig;
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
        backendConfig: { codex: sharedTransport },
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

  assert.deepEqual(embeddedBackendConfig, sharedTransport);
  assert.deepEqual(connectedBackendConfig, sharedTransport);
  assert.deepEqual(connectedBackendConfig, embeddedBackendConfig);
  assert.deepEqual(embedded.outcome.manifest.backendConfig, sharedTransport);
  assert.deepEqual(connected.outcome.manifest.backendConfig, sharedTransport);
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
  assert.equal(outcome.summary.totalAttemptCount, 1);
  assert.ok(stderr.includes("-- attempt 1 (session 1, session attempt 1) --"), "divider on stderr");
  assert.ok(
    !stdout.includes("-- attempt 1 (session 1, session attempt 1) --"),
    "divider not on stdout",
  );
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
  assert.equal(outcome.summary.totalAttemptCount, 2);
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
  assert.equal(outcome.summary.totalAttemptCount, 3);
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

test("fresh runs interpolate named and inline launcher command and args", async () => {
  const dir = tempDir();
  writeAssignment(dir, "three-work", THREE_ASSIGNMENT);
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: "{{cwd}}/bin/wrap"
args:
  - "{{run_group_id}}"
  - "{{cwd}}"
`,
  );
  writeAgent(
    dir,
    "named-launcher-agent",
    `---
schemaVersion: 1
name: named-launcher-agent
backend: claude
launcher: shared
---
Agent prompt.
`,
  );
  writeAgent(
    dir,
    "inline-launcher-agent",
    `---
schemaVersion: 1
name: inline-launcher-agent
backend: claude
launcher:
  command: "{{cwd}}/bin/inline"
  args:
    - "{{run_group_id}}"
    - "{{cwd}}"
---
Agent prompt.
`,
  );

  const namedCwd = join(dir, "named-cwd");
  const { outcome: named } = await runWithMock(
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
    { cwd: namedCwd },
    { agentName: "named-launcher-agent", runGroupId: "launch-g1" },
  );
  assert.deepEqual(named.manifest.launcher, {
    kind: "prefix",
    command: `${namedCwd}/bin/wrap`,
    args: ["launch-g1", namedCwd],
    name: "shared",
    source: "named",
  });
  assert.deepEqual(named.manifest.resetSeed.launcher, named.manifest.launcher);

  const inlineCwd = join(dir, "inline-cwd");
  const { outcome: inline } = await runWithMock(
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
    { cwd: inlineCwd },
    { agentName: "inline-launcher-agent", runGroupId: "launch-g2" },
  );
  assert.deepEqual(inline.manifest.launcher, {
    kind: "prefix",
    command: `${inlineCwd}/bin/inline`,
    args: ["launch-g2", inlineCwd],
    name: null,
    source: "inline",
  });
  assert.deepEqual(inline.manifest.resetSeed.launcher, inline.manifest.launcher);
});

test("resume reuses frozen interpolated launcher and cwd after launcher and group changes", async () => {
  const dir = tempDir();
  const frozenCwd = join(dir, "workspaces", "freeze-g1", "repo");
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
cwd: ${JSON.stringify(join(dir, "workspaces", "{{run_group_id}}", "repo"))}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: "{{cwd}}/bin/wrap"
args: ["{{run_group_id}}"]
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

  const { outcome: first } = await runWithMock(
    dir,
    async (ctx) => {
      setTaskStatusesForPrompt(ctx.prompt, { t1: "completed" });
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-freeze",
        transcript: "done",
        rawStdout: "",
        rawStderr: "",
      };
    },
    {},
    { agentName: "launcher-agent", runGroupId: "freeze-g1" },
  );
  const frozenLauncher = {
    kind: "prefix",
    command: `${frozenCwd}/bin/wrap`,
    args: ["freeze-g1"],
    name: "shared",
    source: "named",
  };
  assert.deepEqual(first.manifest.launcher, frozenLauncher);

  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: mutated
args: [mutated]
`,
  );
  await withSharedRuntimeEnv(dir, () => setRunGroup(first.runId, { runGroupId: "mutated-g2" }));

  let resumedCwd;
  let resumedLauncher;
  const { outcome: resumed } = await runWithMock(
    dir,
    async (ctx) => {
      resumedCwd = ctx.cwd;
      resumedLauncher = ctx.launcher;
      return {
        exitCode: 0,
        signal: null,
        timedOut: false,
        sessionId: "sess-freeze",
        transcript: "resumed",
        rawStdout: "",
        rawStderr: "",
      };
    },
    { message: "resume after group change" },
    {
      agentName: "launcher-agent",
      resume: resolveResumeTarget(first.workspaceDir),
    },
  );

  assert.equal(resumed.manifest.runGroupId, "mutated-g2");
  assert.equal(resumedCwd, frozenCwd);
  assert.deepEqual(resumedLauncher, frozenLauncher);
  assert.deepEqual(resumed.manifest.launcher, frozenLauncher);
});

test("reset restores frozen interpolated launcher without re-reading source or env", async () => {
  const dir = tempDir();
  const frozenCwd = join(dir, "workspaces", "reset-g1", "repo");
  writeAssignment(
    dir,
    "three-work",
    `---
schemaVersion: 1
name: three-work
cwd: ${JSON.stringify(join(dir, "workspaces", "{{run_group_id}}", "repo"))}
tasks:
  - id: t1
    title: First
---
Work.
`,
  );
  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: "{{cwd}}/bin/wrap"
args: ["{{run_group_id}}"]
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

  const { outcome: initialized } = await runWithMock(
    dir,
    async () => {
      throw new Error("backend should not be invoked during init");
    },
    {},
    { agentName: "launcher-agent", runGroupId: "reset-g1", initialize: true },
  );
  const frozenLauncher = {
    kind: "prefix",
    command: `${frozenCwd}/bin/wrap`,
    args: ["reset-g1"],
    name: "shared",
    source: "named",
  };
  assert.deepEqual(initialized.manifest.resetSeed.launcher, frozenLauncher);

  writeLauncher(
    dir,
    "shared",
    `schemaVersion: 1
command: mutated
args: [mutated]
`,
  );
  const manifestPath = join(initialized.workspaceDir, "run.json");
  const mutated = JSON.parse(readFileSync(manifestPath, "utf8"));
  mutated.launcher = { kind: "direct", name: "direct" };
  writeFileSync(manifestPath, `${JSON.stringify(mutated, null, 2)}\n`);

  const reset = await withSharedRuntimeEnv(dir, () =>
    withEnv({ AGENT_RUNNER_RUN_GROUP_ID: "env-g2" }, () => resetRun(initialized.workspaceDir)),
  );
  assert.equal(reset.manifest.cwd, frozenCwd);
  assert.deepEqual(reset.manifest.launcher, frozenLauncher);
  assert.deepEqual(reset.manifest.resetSeed.launcher, frozenLauncher);
});

test("fresh runs keep passive and external codex transports on direct launcher", async () => {
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
backendConfig:
  codex:
    transport:
      type: ws
      url: ws://127.0.0.1:4773/
---
Agent prompt.
`,
  );
  writeAgent(
    dir,
    "codex-uds-launcher-agent",
    `---
schemaVersion: 1
name: codex-uds-launcher-agent
backend: codex
launcher: shared
backendConfig:
  codex:
    transport:
      type: uds
      path: /tmp/codex.sock
---
Agent prompt.
`,
  );

  const { outcome: wsOutcome } = await runWithMock(
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

  assert.deepEqual(wsOutcome.manifest.launcher, {
    kind: "direct",
    name: "direct",
  });
  assert.deepEqual(wsOutcome.manifest.resetSeed.launcher, wsOutcome.manifest.launcher);

  const { outcome: udsOutcome } = await runWithMock(
    dir,
    async () => ({
      exitCode: 0,
      signal: null,
      timedOut: false,
      sessionId: "thread-uds",
      transcript: "done",
      rawStdout: "",
      rawStderr: "",
    }),
    {},
    { agentName: "codex-uds-launcher-agent", backendId: "codex" },
  );

  assert.deepEqual(udsOutcome.manifest.launcher, {
    kind: "direct",
    name: "direct",
  });
  assert.deepEqual(udsOutcome.manifest.resetSeed.launcher, udsOutcome.manifest.launcher);
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
