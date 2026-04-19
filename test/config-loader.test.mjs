import { strict as assert } from "node:assert";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve as resolvePath } from "node:path";
import { test } from "node:test";
import {
  AgentConfigError,
  AgentNotFoundError,
  AssignmentConfigError,
  AssignmentNotFoundError,
  DefinitionListError,
  listAgents,
  listAssignments,
  loadAgentConfig,
  loadAssignmentConfig,
  resolveAgentPath,
  resolveAssignmentPath,
} from "../packages/core/dist/config/loader.js";
import { withEnv, withRuntimeRoots } from "./helpers/runtime-paths.mjs";

const MINIMAL_AGENT = `---
schemaVersion: 1
name: demo
backend: claude
---
You are an assistant.
`;

const MINIMAL_ASSIGNMENT = `---
schemaVersion: 1
name: demo-work
tasks:
  - id: t1
    title: Do the thing
    body: First thing to do.
---
Work on the repo. Plan at {{assignment_path}}.
`;

function tempDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-loader-extra-"));
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

const BUILTIN_PLAN_FEATURE_PATH = resolvePath(
  new URL("../assignments/plan-feature/assignment.md", import.meta.url).pathname,
);
const BUILTIN_PLAN_TEMPLATE_PATH = resolvePath(
  new URL("../assignments/plan-feature/template.md", import.meta.url).pathname,
);
const BUILTIN_IMPLEMENTER_AGENT_PATH = resolvePath(
  new URL("../agents/implementer/agent.md", import.meta.url).pathname,
);

test("loadAgentConfig parses a minimal agent.md from TASK_RUNNER_CONFIG_DIR", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(configDir, "demo", MINIMAL_AGENT);

    const loaded = loadAgentConfig("demo", rootDir);
    assert.equal(loaded.config.name, "demo");
    assert.equal(loaded.config.backend, "claude");
    assert.equal(loaded.config.timeoutSec, 3600);
    assert.equal(loaded.config.unrestricted, false);
    assert.ok(!("maxRetries" in loaded.config), "maxRetries moved to assignment schema");
    assert.ok(loaded.instructions.includes("You are an assistant."));
  }));

test("loadAssignmentConfig loads authored cwd from assignment frontmatter", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "explicit-cwd",
      `---
schemaVersion: 1
name: explicit-cwd
cwd: .
tasks:
  - id: t1
    title: First
---
body
`,
    );

    const loaded = loadAssignmentConfig("explicit-cwd", rootDir);
    assert.equal(loaded.config.cwd, ".");
  }));

test("loadAssignmentConfig rejects empty authored cwd after trimming", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "blank-cwd",
      `---
schemaVersion: 1
name: blank-cwd
cwd: "   "
tasks:
  - id: t1
    title: First
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("blank-cwd", rootDir), AssignmentConfigError);
  }));

test("loadAgentConfig throws AgentConfigError on bad frontmatter", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "bad",
      `---
schemaVersion: 1
backend: claude
---
body
`,
    );

    assert.throws(() => loadAgentConfig("bad", rootDir), AgentConfigError);
  }));

test("loadAgentConfig silently drops `tasks` (which belongs on assignments)", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "with-tasks",
      `---
schemaVersion: 1
name: with-tasks
backend: claude
tasks:
  - id: t1
    title: First
---
body
`,
    );

    const loaded = loadAgentConfig("with-tasks", rootDir);
    assert.equal(loaded.config.name, "with-tasks");
    assert.ok(!("tasks" in loaded.config), "tasks stripped from agent config");
  }));

test("loadAgentConfig accepts agent with no tasks/vars/message fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "notasks",
      `---
schemaVersion: 1
name: notasks
backend: claude
---
body
`,
    );

    const loaded = loadAgentConfig("notasks", rootDir);
    assert.equal(loaded.config.name, "notasks");
  }));

test("loadAgentConfig resolves exact-match env fields and prose instructions", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv(
      {
        AGENT_NAME: "env-agent",
        AGENT_MODEL: "gpt-5.4",
        AGENT_TIMEOUT: "90",
        AGENT_UNRESTRICTED: "true",
        CODEX_URL: "ws://127.0.0.1:4773/socket",
        BODY_TARGET: "release board",
      },
      () => {
        writeAgent(
          configDir,
          "env-agent",
          `---
schemaVersion: \${AGENT_SCHEMA:-1}
name: \${AGENT_NAME}
backend: codex
model: \${AGENT_MODEL}
timeoutSec: \${AGENT_TIMEOUT}
unrestricted: \${AGENT_UNRESTRICTED}
backendSpecific:
  codex:
    transport:
      type: ws
      url: \${CODEX_URL}
---
Operate on the \${BODY_TARGET}.
`,
        );

        const loaded = loadAgentConfig("env-agent", rootDir);
        assert.equal(loaded.config.schemaVersion, 1);
        assert.equal(loaded.config.name, "env-agent");
        assert.equal(loaded.config.model, "gpt-5.4");
        assert.equal(loaded.config.timeoutSec, 90);
        assert.equal(loaded.config.unrestricted, true);
        assert.deepEqual(loaded.config.backendSpecific, {
          codex: {
            transport: {
              type: "ws",
              url: "ws://127.0.0.1:4773/socket",
            },
          },
        });
        assert.equal(loaded.instructions, "Operate on the release board.");
      },
    ),
  ));

test("loadAssignmentConfig resolves typed fields, prose fields, and env-backed var defaults", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv(
      {
        ASSIGNMENT_NAME: "env-work",
        ASSIGNMENT_CWD: "packages/core",
        MAX_RETRIES: "7",
        DEFAULT_RETRIES: "5",
        TASK_TARGET: "deployments",
        DESCRIPTION_TARGET: "staging",
        BODY_TARGET: "workspace",
      },
      () => {
        writeAssignment(
          configDir,
          "env-work",
          `---
schemaVersion: \${ASSIGNMENT_SCHEMA:-1}
name: \${ASSIGNMENT_NAME}
cwd: \${ASSIGNMENT_CWD}
maxRetries: \${MAX_RETRIES}
message: Ship \${TASK_TARGET}
callerInstructions: Review \${DESCRIPTION_TARGET} first
vars:
  retries:
    type: number
    default: \${DEFAULT_RETRIES}
    description: Uses \${DESCRIPTION_TARGET}
tasks:
  - id: release
    title: Release \${TASK_TARGET}
    body: Verify \${TASK_TARGET}
---
Assignment body for \${BODY_TARGET}.
`,
        );

        const loaded = loadAssignmentConfig("env-work", rootDir);
        assert.equal(loaded.config.schemaVersion, 1);
        assert.equal(loaded.config.name, "env-work");
        assert.equal(loaded.config.cwd, "packages/core");
        assert.equal(loaded.config.maxRetries, 7);
        assert.equal(loaded.config.message, "Ship deployments");
        assert.equal(loaded.config.callerInstructions, "Review staging first");
        assert.equal(loaded.config.vars.retries.default, "5");
        assert.equal(loaded.config.vars.retries.description, "Uses staging");
        assert.equal(loaded.config.tasks[0].title, "Release deployments");
        assert.equal(loaded.config.tasks[0].body, "Verify deployments");
        assert.equal(loaded.instructions, "Assignment body for workspace.");
      },
    ),
  ));

for (const { name, expression, envValue, expected } of [
  {
    name: "exact env field uses the current value when set",
    expression: "${RETRIES}",
    envValue: "4",
    expected: 4,
  },
  {
    name: ":- fallback uses the env value when non-empty",
    expression: "${RETRIES:-6}",
    envValue: "9",
    expected: 9,
  },
  {
    name: ":- fallback uses the fallback when env is unset",
    expression: "${RETRIES:-6}",
    envValue: undefined,
    expected: 6,
  },
  {
    name: ":- fallback uses the fallback when env is empty",
    expression: "${RETRIES:-6}",
    envValue: "",
    expected: 6,
  },
  {
    name: "- fallback uses the fallback when env is unset",
    expression: "${RETRIES-6}",
    envValue: undefined,
    expected: 6,
  },
]) {
  test(`loadAssignmentConfig ${name}`, () =>
    withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
      withEnv({ RETRIES: envValue }, () => {
        writeAssignment(
          configDir,
          "fallbacks",
          `---
schemaVersion: 1
name: fallbacks
maxRetries: ${expression}
---
body
`,
        );

        const loaded = loadAssignmentConfig("fallbacks", rootDir);
        assert.equal(loaded.config.maxRetries, expected);
      }),
    ));
}

test("loadAssignmentConfig treats an empty env value as empty for - fallback exact fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ RETRIES: "" }, () => {
      writeAssignment(
        configDir,
        "dash-empty",
        `---
schemaVersion: 1
name: dash-empty
maxRetries: \${RETRIES-6}
---
body
`,
      );

      assert.throws(
        () => loadAssignmentConfig("dash-empty", rootDir),
        (err) => {
          assert.ok(err instanceof AssignmentConfigError);
          assert.match(err.message, /assignment\.maxRetries/);
          assert.match(err.message, /RETRIES/);
          assert.match(err.message, /empty/);
          return true;
        },
      );
    }),
  ));

test("loadAssignmentConfig rejects missing required exact env fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ RETRIES: undefined }, () => {
      writeAssignment(
        configDir,
        "missing-env",
        `---
schemaVersion: 1
name: missing-env
maxRetries: \${RETRIES}
---
body
`,
      );

      assert.throws(
        () => loadAssignmentConfig("missing-env", rootDir),
        (err) => {
          assert.ok(err instanceof AssignmentConfigError);
          assert.match(err.message, /assignment\.maxRetries/);
          assert.match(err.message, /RETRIES/);
          assert.match(err.message, /missing/);
          return true;
        },
      );
    }),
  ));

test("loadAssignmentConfig rejects empty required exact env fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ RETRIES: "" }, () => {
      writeAssignment(
        configDir,
        "empty-env",
        `---
schemaVersion: 1
name: empty-env
maxRetries: \${RETRIES}
---
body
`,
      );

      assert.throws(
        () => loadAssignmentConfig("empty-env", rootDir),
        (err) => {
          assert.ok(err instanceof AssignmentConfigError);
          assert.match(err.message, /assignment\.maxRetries/);
          assert.match(err.message, /RETRIES/);
          assert.match(err.message, /empty/);
          return true;
        },
      );
    }),
  ));

test("loadAgentConfig rejects partial interpolation in exact-only fields", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
    withEnv({ AGENT_NAME: "demo" }, () => {
      writeAgent(
        configDir,
        "partial-exact",
        `---
schemaVersion: 1
name: agent-\${AGENT_NAME}
backend: claude
---
body
`,
      );

      assert.throws(
        () => loadAgentConfig("partial-exact", rootDir),
        (err) => {
          assert.ok(err instanceof AgentConfigError);
          assert.match(err.message, /agent\.name/);
          assert.match(err.message, /AGENT_NAME/);
          assert.match(err.message, /mismatch with field surface/);
          return true;
        },
      );
    }),
  ));

test("loadAgentConfig reports invalid env syntax with path context", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "invalid-syntax",
      `---
schemaVersion: 1
name: \${BROKEN
backend: claude
---
body
`,
    );

    assert.throws(
      () => loadAgentConfig("invalid-syntax", rootDir),
      (err) => {
        assert.ok(err instanceof AgentConfigError);
        assert.match(err.message, /agent\.name/);
        assert.match(err.message, /BROKEN/);
        assert.match(err.message, /invalid syntax/);
        return true;
      },
    );
  }));

for (const { name, writer, load, id, expectedPath, expectedEnv } of [
  {
    name: "loadAgentConfig rejects env blob replacement for backendSpecific",
    writer: (configDir) =>
      writeAgent(
        configDir,
        "blob-agent",
        `---
schemaVersion: 1
name: blob-agent
backend: codex
backendSpecific: \${CODEX_SETTINGS}
---
body
`,
      ),
    load: loadAgentConfig,
    id: "blob-agent",
    expectedPath: /agent\.backendSpecific/,
    expectedEnv: /CODEX_SETTINGS/,
  },
  {
    name: "loadAssignmentConfig rejects env blob replacement for tasks",
    writer: (configDir) =>
      writeAssignment(
        configDir,
        "blob-tasks",
        `---
schemaVersion: 1
name: blob-tasks
tasks: \${TASKS}
---
body
`,
      ),
    load: loadAssignmentConfig,
    id: "blob-tasks",
    expectedPath: /assignment\.tasks/,
    expectedEnv: /TASKS/,
  },
  {
    name: "loadAssignmentConfig rejects env blob replacement for lockedFields",
    writer: (configDir) =>
      writeAssignment(
        configDir,
        "blob-locks",
        `---
schemaVersion: 1
name: blob-locks
lockedFields: \${LOCKS}
---
body
`,
      ),
    load: loadAssignmentConfig,
    id: "blob-locks",
    expectedPath: /assignment\.lockedFields/,
    expectedEnv: /LOCKS/,
  },
]) {
  test(name, () =>
    withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) =>
      withEnv(
        {
          CODEX_SETTINGS: '{"codex":{"transport":{"type":"ws","url":"ws://127.0.0.1:4773/"}}}',
          TASKS: '[{"id":"t1","title":"Injected"}]',
          LOCKS: '["backend"]',
        },
        () => {
          writer(configDir);

          assert.throws(
            () => load(id, rootDir),
            (err) => {
              const expectedClass =
                load === loadAgentConfig ? AgentConfigError : AssignmentConfigError;
              assert.ok(err instanceof expectedClass);
              assert.match(err.message, expectedPath);
              assert.match(err.message, expectedEnv);
              assert.match(err.message, /mismatch with field surface/);
              return true;
            },
          );
        },
      ),
    ));
}

test("loadAgentConfig accepts backendSpecific.codex.transport in agent frontmatter", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "codex-transport",
      `---
schemaVersion: 1
name: codex-transport
backend: codex
backendSpecific:
  codex:
    transport:
      type: ws
      url: ws://127.0.0.1:4773/
---
body
`,
    );

    const loaded = loadAgentConfig("codex-transport", rootDir);
    assert.deepEqual(loaded.config.backendSpecific, {
      codex: {
        transport: {
          type: "ws",
          url: "ws://127.0.0.1:4773/",
        },
      },
    });
  }));

test("loadAgentConfig rejects invalid backendSpecific.codex.transport values", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(
      configDir,
      "bad-transport",
      `---
schemaVersion: 1
name: bad-transport
backend: codex
backendSpecific:
  codex:
    transport:
      type: ws
      url: https://example.com/not-ws
      extra: true
---
body
`,
    );

    assert.throws(
      () => loadAgentConfig("bad-transport", rootDir),
      (err) => {
        assert.ok(err instanceof AgentConfigError);
        assert.match(err.message, /backendSpecific\.codex\.transport/);
        return true;
      },
    );
  }));

test("loadAgentConfig throws AgentNotFoundError for missing agent and lists config-root path", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    assert.throws(
      () => loadAgentConfig("nope", rootDir),
      (err) => {
        assert.ok(err instanceof AgentNotFoundError);
        assert.deepEqual(err.searched, [join(configDir, "agents", "nope", "agent.md")]);
        return true;
      },
    );
  }));

test("resolveAgentPath accepts a direct path", () => {
  const dir = tempDir();
  const agentPath = writeAgent(dir, "demo", MINIMAL_AGENT);

  const resolved = resolveAgentPath(agentPath, dir);
  assert.equal(resolved, agentPath);
});

test("loadAssignmentConfig parses a minimal assignment.md from TASK_RUNNER_CONFIG_DIR", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(configDir, "demo-work", MINIMAL_ASSIGNMENT);

    const loaded = loadAssignmentConfig("demo-work", rootDir);
    assert.equal(loaded.config.name, "demo-work");
    assert.equal(loaded.config.tasks.length, 1);
    assert.equal(loaded.config.tasks[0].id, "t1");
    assert.equal(loaded.config.maxRetries, 3, "maxRetries defaults to 3 on assignment");
    assert.ok(loaded.instructions.includes("{{assignment_path}}"));
  }));

test("built-in plan-feature assignment uses cwd instead of repo_path for canonical repo context", () => {
  const loaded = loadAssignmentConfig(BUILTIN_PLAN_FEATURE_PATH);
  assert.equal(loaded.config.vars.repo_path, undefined);
  assert.match(loaded.instructions, /`{{cwd}}`/);
  assert.ok((loaded.config.callerInstructions ?? "").includes("--assignment plan-feature"));
});

test("built-in plan-feature template emits implement-prefixed assignment names", () => {
  const template = readFileSync(BUILTIN_PLAN_TEMPLATE_PATH, "utf8");
  assert.match(template, /^name: implement-<<KEBAB_FEATURE_SLUG>>$/m);
  assert.doesNotMatch(template, /^name: plan-<<KEBAB_FEATURE_SLUG>>$/m);
});

test("built-in implementer agent points reviewers at the run record, not workspace assignment.md", () => {
  const loaded = loadAgentConfig(BUILTIN_IMPLEMENTER_AGENT_PATH);
  assert.match(loaded.instructions, /reading the run record after the fact/i);
  assert.doesNotMatch(loaded.instructions, /workspace `assignment\.md`/i);
});

test("loadAssignmentConfig throws AssignmentNotFoundError for missing assignment and lists config-root path", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    assert.throws(
      () => loadAssignmentConfig("nope-work", rootDir),
      (err) => {
        assert.ok(err instanceof AssignmentNotFoundError);
        assert.deepEqual(err.searched, [
          join(configDir, "assignments", "nope-work", "assignment.md"),
        ]);
        return true;
      },
    );
  }));

test("resolveAssignmentPath accepts a direct path", () => {
  const dir = tempDir();
  const assignmentPath = writeAssignment(dir, "demo-work", MINIMAL_ASSIGNMENT);

  const resolved = resolveAssignmentPath(assignmentPath, dir);
  assert.equal(resolved, assignmentPath);
});

test("assignment schema rejects duplicate task ids", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "dup",
      `---
schemaVersion: 1
name: dup
tasks:
  - id: t1
    title: First
  - id: t1
    title: Duplicate
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("dup", rootDir), AssignmentConfigError);
  }));

test("assignment schema rejects multiline task titles", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "multiline-title",
      `---
schemaVersion: 1
name: multiline-title
tasks:
  - id: t1
    title: |-
      Line 1
      Line 2
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("multiline-title", rootDir), AssignmentConfigError);
  }));

test("assignment schema rejects incompatible var defaults", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAssignment(
      configDir,
      "bad-default",
      `---
schemaVersion: 1
name: bad-default
vars:
  retries:
    type: number
    default: nope
---
body
`,
    );

    assert.throws(() => loadAssignmentConfig("bad-default", rootDir), AssignmentConfigError);
  }));

test("loadAgentConfig does not fall back to cwd-local bare names", () =>
  withRuntimeRoots("task-runner-loader-", ({ rootDir, configDir }) => {
    writeAgent(rootDir, "demo", MINIMAL_AGENT);

    assert.throws(
      () => loadAgentConfig("demo", rootDir),
      (err) => {
        assert.ok(err instanceof AgentNotFoundError);
        assert.deepEqual(err.searched, [join(configDir, "agents", "demo", "agent.md")]);
        return true;
      },
    );
  }));

test("listAgents discovers config-root agents", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAgent(configDir, "alpha", MINIMAL_AGENT);
    writeAgent(configDir, "beta", MINIMAL_AGENT);

    const entries = listAgents();
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("alpha"));
    assert.ok(names.includes("beta"));
    assert.equal(entries[0].root, "config");
  }));

test("listAssignments discovers config-root assignments", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAssignment(configDir, "work-a", MINIMAL_ASSIGNMENT);
    writeAssignment(configDir, "work-b", MINIMAL_ASSIGNMENT);

    const entries = listAssignments();
    const names = entries.map((e) => e.name);
    assert.ok(names.includes("work-a"));
    assert.ok(names.includes("work-b"));
  }));

test("listAgents returns sorted names", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAgent(configDir, "zeta", MINIMAL_AGENT);
    writeAgent(configDir, "alpha", MINIMAL_AGENT);
    writeAgent(configDir, "mid", MINIMAL_AGENT);

    const entries = listAgents();
    const names = entries.map((e) => e.name);
    assert.deepEqual(names, ["alpha", "mid", "zeta"]);
  }));

test("listAgents returns empty array when no agents exist", () =>
  withRuntimeRoots("task-runner-loader-", () => {
    const entries = listAgents();
    assert.deepEqual(entries, []);
  }));

test("listAssignments returns empty array when no assignments exist", () =>
  withRuntimeRoots("task-runner-loader-", () => {
    const entries = listAssignments();
    assert.deepEqual(entries, []);
  }));

test("listAgents skips directories without agent.md", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    writeAgent(configDir, "real", MINIMAL_AGENT);
    mkdirSync(join(configDir, "agents", "empty"), { recursive: true });

    const entries = listAgents();
    assert.equal(entries.length, 1);
    assert.equal(entries[0].name, "real");
  }));

test("TASK_RUNNER_CONFIG_DIR overrides XDG_CONFIG_HOME and HOME fallbacks", () => {
  const explicitRoot = tempDir();
  const xdgRoot = tempDir();
  const homeRoot = tempDir();
  writeAgent(explicitRoot, "explicit", MINIMAL_AGENT);
  writeAgent(join(xdgRoot, "task-runner"), "xdg", MINIMAL_AGENT);
  writeAgent(join(homeRoot, ".config", "task-runner"), "home", MINIMAL_AGENT);

  withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: explicitRoot,
      XDG_CONFIG_HOME: xdgRoot,
      HOME: homeRoot,
    },
    () => {
      const entries = listAgents();
      assert.deepEqual(
        entries.map((entry) => entry.name),
        ["explicit"],
      );
    },
  );
});

test("XDG_CONFIG_HOME fallback is used when TASK_RUNNER_CONFIG_DIR is unset", () => {
  const xdgRoot = tempDir();
  const homeRoot = tempDir();
  writeAssignment(join(xdgRoot, "task-runner"), "demo-work", MINIMAL_ASSIGNMENT);

  withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: xdgRoot,
      HOME: homeRoot,
    },
    () => {
      const loaded = loadAssignmentConfig("demo-work");
      assert.equal(
        loaded.sourcePath,
        join(xdgRoot, "task-runner", "assignments", "demo-work", "assignment.md"),
      );
    },
  );
});

test("HOME fallback uses ~/.config/task-runner when explicit and XDG vars are unset", () => {
  const homeRoot = tempDir();
  writeAgent(join(homeRoot, ".config", "task-runner"), "demo", MINIMAL_AGENT);

  withEnv(
    {
      TASK_RUNNER_CONFIG_DIR: undefined,
      XDG_CONFIG_HOME: undefined,
      HOME: homeRoot,
    },
    () => {
      const loaded = loadAgentConfig("demo");
      assert.equal(
        loaded.sourcePath,
        join(homeRoot, ".config", "task-runner", "agents", "demo", "agent.md"),
      );
    },
  );
});

test("listAgents throws DefinitionListError when config agents directory is unreadable", () =>
  withRuntimeRoots("task-runner-loader-", ({ configDir }) => {
    const agentsDir = join(configDir, "agents");
    mkdirSync(agentsDir, { recursive: true });
    writeAgent(configDir, "visible", MINIMAL_AGENT);
    chmodSync(agentsDir, 0o000);
    try {
      assert.throws(() => listAgents(), DefinitionListError);
    } finally {
      chmodSync(agentsDir, 0o755);
    }
  }));
