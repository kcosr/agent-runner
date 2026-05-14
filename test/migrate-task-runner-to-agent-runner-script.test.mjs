import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { test } from "node:test";

const SCRIPT_PATH = resolvePath(
  new URL("../scripts/migrate-task-runner-to-agent-runner.mjs", import.meta.url).pathname,
);
const DAEMON_ENV_VARS = [
  "AGENT_RUNNER_CONNECT",
  "AGENT_RUNNER_LISTEN",
  "TASK_RUNNER_CONNECT",
  "TASK_RUNNER_LISTEN",
];

function tempHome() {
  return mkdtempSync(join(tmpdir(), "agent-runner-rename-migrate-"));
}

function migrationEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  for (const name of DAEMON_ENV_VARS) {
    if (!(name in extra)) delete env[name];
  }
  return env;
}

function writeText(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text, "utf8");
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function seedLegacyHome(home) {
  writeText(
    join(home, ".local/state/task-runner/runs/task-runner/run-a/run.json"),
    `${JSON.stringify(
      {
        repo: "task-runner",
        packageName: "@task-runner/core",
        header: "x-task-runner-attachment-name",
        commandVar: "{{task_runner_cmd}}",
        env: "TASK_RUNNER_STATE_DIR",
        display: "TaskRunner",
        sessions: [
          {
            sessionIndex: 0,
            provenance: { kind: "task_runner" },
          },
        ],
        attemptRecords: [
          {
            attempt: 0,
            sessionIndex: 0,
            attemptIndexInSession: 0,
            provenance: { kind: "task_runner" },
          },
        ],
      },
      null,
      2,
    )}\n`,
  );
  writeText(
    join(home, ".config/task-runner/agents/task-runner-agent.md"),
    "Use task-runner and ${TASK_RUNNER_CONFIG_DIR} with @task-runner/core.\n",
  );
  writeText(
    join(home, ".bashrc"),
    "export TASK_RUNNER_STATE_DIR=/tmp/task-runner\nexport KEEP_ME=1\n",
  );
}

test("migrate-task-runner-to-agent-runner dry-runs without changing legacy data", () => {
  const home = tempHome();
  seedLegacyHome(home);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--home", home], {
    encoding: "utf8",
    env: migrationEnv(),
  });

  assert.match(
    stdout,
    /DRY\s+state: would move .*\.local\/state\/task-runner -> .*\.local\/state\/agent-runner/,
  );
  assert.match(
    stdout,
    /DRY\s+config: would move .*\.config\/task-runner -> .*\.config\/agent-runner/,
  );
  assert.match(stdout, /DRY\s+bashrc: would rewrite/);
  assert.match(stdout, /SUMMARY mode=dry-run/);
  assert.equal(existsSync(join(home, ".local/state/task-runner")), true);
  assert.equal(existsSync(join(home, ".local/state/agent-runner")), false);
  assert.match(
    readText(join(home, ".local/state/task-runner/runs/task-runner/run-a/run.json")),
    /task-runner/,
  );
  assert.match(readText(join(home, ".bashrc")), /TASK_RUNNER_STATE_DIR/);
});

test("migrate-task-runner-to-agent-runner writes renamed roots, paths, and content", () => {
  const home = tempHome();
  seedLegacyHome(home);

  const stdout = execFileSync("node", [SCRIPT_PATH, "--home", home, "--write"], {
    encoding: "utf8",
    env: migrationEnv(),
  });

  assert.match(stdout, /WRITE\s+state: moved/);
  assert.match(stdout, /WRITE\s+config: moved/);
  assert.match(stdout, /WRITE\s+bashrc: rewrote/);
  assert.match(stdout, /SUMMARY mode=write/);
  assert.equal(existsSync(join(home, ".local/state/task-runner")), false);
  assert.equal(existsSync(join(home, ".config/task-runner")), false);
  assert.equal(
    existsSync(join(home, ".local/state/agent-runner/runs/agent-runner/run-a/run.json")),
    true,
  );
  assert.equal(existsSync(join(home, ".config/agent-runner/agents/agent-runner-agent.md")), true);

  const manifest = readText(
    join(home, ".local/state/agent-runner/runs/agent-runner/run-a/run.json"),
  );
  assert.match(manifest, /"repo": "agent-runner"/);
  assert.match(manifest, /"packageName": "@kcosr\/agent-runner-core"/);
  assert.match(manifest, /"header": "x-agent-runner-attachment-name"/);
  assert.match(manifest, /"commandVar": "{{agent_runner_cmd}}"/);
  assert.match(manifest, /"env": "AGENT_RUNNER_STATE_DIR"/);
  assert.match(manifest, /"display": "AgentRunner"/);
  assert.match(manifest, /"kind": "task_runner"/);
  assert.doesNotMatch(manifest, /"kind": "agent_runner"/);

  const agent = readText(join(home, ".config/agent-runner/agents/agent-runner-agent.md"));
  assert.match(agent, /agent-runner/);
  assert.match(agent, /AGENT_RUNNER_CONFIG_DIR/);
  assert.match(agent, /@kcosr\/agent-runner-core/);
  assert.doesNotMatch(agent, /task-runner|TASK_RUNNER|@task-runner/);
  assert.equal(
    readText(join(home, ".bashrc")),
    "export AGENT_RUNNER_STATE_DIR=/tmp/agent-runner\nexport KEEP_ME=1\n",
  );
});

test("migrate-task-runner-to-agent-runner blocks conflicting target roots before writes", () => {
  const home = tempHome();
  seedLegacyHome(home);
  writeText(join(home, ".local/state/agent-runner/existing.txt"), "existing\n");

  const result = spawnSync("node", [SCRIPT_PATH, "--home", home, "--write", "--skip-bashrc"], {
    encoding: "utf8",
    env: migrationEnv(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONFLICT state:/);
  assert.match(result.stderr, /Migration aborted before writing changes/);
  assert.equal(existsSync(join(home, ".local/state/task-runner")), true);
  assert.equal(existsSync(join(home, ".config/task-runner")), true);
  assert.equal(existsSync(join(home, ".config/agent-runner")), false);
  assert.match(
    readText(join(home, ".local/state/task-runner/runs/task-runner/run-a/run.json")),
    /task-runner/,
  );
});

test("migrate-task-runner-to-agent-runner preflights all roots before moving state", () => {
  const home = tempHome();
  seedLegacyHome(home);
  writeText(join(home, ".config/agent-runner/existing.txt"), "existing\n");

  const result = spawnSync("node", [SCRIPT_PATH, "--home", home, "--write", "--skip-bashrc"], {
    encoding: "utf8",
    env: migrationEnv(),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONFLICT config:/);
  assert.match(result.stderr, /Migration aborted before writing changes/);
  assert.equal(existsSync(join(home, ".local/state/task-runner")), true);
  assert.equal(existsSync(join(home, ".local/state/agent-runner")), false);
  assert.equal(existsSync(join(home, ".config/task-runner")), true);
});

test("migrate-task-runner-to-agent-runner blocks write while daemon env is active", () => {
  const home = tempHome();
  seedLegacyHome(home);

  const result = spawnSync("node", [SCRIPT_PATH, "--home", home, "--write", "--skip-bashrc"], {
    encoding: "utf8",
    env: migrationEnv({ TASK_RUNNER_CONNECT: "http://127.0.0.1:4773" }),
  });

  assert.equal(result.status, 1);
  assert.match(result.stderr, /CONFLICT daemon: TASK_RUNNER_CONNECT is set/);
  assert.match(result.stderr, /Migration aborted before writing changes/);
  assert.equal(existsSync(join(home, ".local/state/task-runner")), true);
  assert.equal(existsSync(join(home, ".local/state/agent-runner")), false);
});
