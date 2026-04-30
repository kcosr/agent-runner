import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BackendConfigError,
  UnknownBackendError,
  knownBackends,
  loadCustomBackends,
  resolveBackend,
} from "../packages/core/dist/backends/registry.js";

function tempConfigDir() {
  return mkdtempSync(join(tmpdir(), "task-runner-backends-"));
}

function writeBackend(configDir, name, filename, source) {
  const dir = join(configDir, "backends", name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, filename), source);
}

test("registry: claude, codex, cursor, pi, and passive are known", () => {
  const known = knownBackends();
  assert.ok(known.includes("claude"));
  assert.ok(known.includes("codex"));
  assert.ok(known.includes("cursor"));
  assert.ok(known.includes("pi"));
  assert.ok(known.includes("passive"));
});

test("registry: resolveBackend returns the adapter", () => {
  const claude = resolveBackend("claude");
  assert.equal(claude.id, "claude");
  const codex = resolveBackend("codex");
  assert.equal(codex.id, "codex");
  const cursor = resolveBackend("cursor");
  assert.equal(cursor.id, "cursor");
  const pi = resolveBackend("pi");
  assert.equal(pi.id, "pi");
});

test("registry: unknown backend throws UnknownBackendError", () => {
  assert.throws(() => resolveBackend("gemini"), UnknownBackendError);
});

test("registry: missing custom backends root keeps built-ins", async () => {
  const configDir = tempConfigDir();
  await loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir });
  const known = knownBackends();
  assert.ok(known.includes("claude"));
  assert.equal(known.includes("my-agent"), false);
});

test("registry: loads custom backend default export", async () => {
  const configDir = tempConfigDir();
  writeBackend(
    configDir,
    "my-agent",
    "backend.mjs",
    `export default {
      id: "my-agent",
      launcherMode: "direct",
      resolveConfig(ctx) { return ctx.authoredConfig; },
      async invoke() {
        return {
          exitCode: 0,
          signal: null,
          timedOut: false,
          aborted: false,
          sessionId: "custom-session",
          transcript: "ok",
          rawStdout: "",
          rawStderr: ""
        };
      }
    };`,
  );

  await loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir });
  const backend = resolveBackend("my-agent");
  assert.equal(backend.id, "my-agent");
  assert.equal(backend.launcherMode, "direct");
  assert.ok(knownBackends().includes("my-agent"));
  assert.throws(() => resolveBackend("missing-agent"), /my-agent/);
});

for (const [ext, source] of [
  [
    "js",
    `export default {
      id: "agent-js",
      async invoke() { return { exitCode: 0, signal: null, timedOut: false, aborted: false }; }
    };`,
  ],
  [
    "mjs",
    `export default {
      id: "agent-mjs",
      async invoke() { return { exitCode: 0, signal: null, timedOut: false, aborted: false }; }
    };`,
  ],
  [
    "ts",
    `export default {
      id: "agent-ts",
      async invoke(): Promise<Record<string, unknown>> {
        return { exitCode: 0, signal: null, timedOut: false, aborted: false };
      }
    };`,
  ],
  [
    "mts",
    `export default {
      id: "agent-mts",
      async invoke(): Promise<Record<string, unknown>> {
        return { exitCode: 0, signal: null, timedOut: false, aborted: false };
      }
    };`,
  ],
]) {
  test(`registry: loads custom backend from backend.${ext}`, async () => {
    const configDir = tempConfigDir();
    const name = `agent-${ext}`;
    writeBackend(configDir, name, `backend.${ext}`, source);

    await loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir });
    assert.equal(resolveBackend(name).id, name);
    assert.ok(knownBackends().includes(name));
  });
}

test("registry: rejects custom backend id mismatch", async () => {
  const configDir = tempConfigDir();
  writeBackend(
    configDir,
    "actual-name",
    "backend.mjs",
    `export default { id: "other-name", async invoke() {} };`,
  );

  await assert.rejects(
    () => loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir }),
    (err) =>
      err instanceof BackendConfigError &&
      err.backendName === "actual-name" &&
      /id must match backend directory name "actual-name"/.test(err.message) &&
      /backend\.mjs/.test(err.sourcePath),
  );
});

test("registry: import failure includes backend name and module path", async () => {
  const configDir = tempConfigDir();
  writeBackend(
    configDir,
    "broken-import",
    "backend.mjs",
    `import "./missing-module.mjs";
    export default { id: "broken-import", async invoke() {} };`,
  );

  await assert.rejects(
    () => loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir }),
    (err) =>
      err instanceof BackendConfigError &&
      err.backendName === "broken-import" &&
      /backend\.mjs/.test(err.sourcePath) &&
      /failed to import backend module/.test(err.message) &&
      /missing-module/.test(err.message),
  );
});

test("registry: rejects custom backend using a reserved built-in name", async () => {
  const configDir = tempConfigDir();
  writeBackend(
    configDir,
    "codex",
    "backend.mjs",
    `export default { id: "codex", async invoke() {} };`,
  );

  await assert.rejects(
    () => loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir }),
    (err) =>
      err instanceof BackendConfigError &&
      err.backendName === "codex" &&
      /reserved/.test(err.message),
  );
});

test("registry: rejects named-only custom backend modules", async () => {
  const configDir = tempConfigDir();
  writeBackend(
    configDir,
    "named-only",
    "backend.mjs",
    `export const backend = { id: "named-only", async invoke() {} };`,
  );

  await assert.rejects(
    () => loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir }),
    (err) =>
      err instanceof BackendConfigError &&
      err.backendName === "named-only" &&
      /default export is required/.test(err.message) &&
      /backend\.mjs/.test(err.sourcePath),
  );
});

test("registry: validates custom backend optional fields", async () => {
  const configDir = tempConfigDir();
  writeBackend(
    configDir,
    "bad-options",
    "backend.mjs",
    `export default {
      id: "bad-options",
      invoke: "not a function",
      validateSessionId: true,
      supportsBootstrapSessionImport: "yes",
      resolveConfig: {},
      launcherMode: "maybe"
    };`,
  );

  await assert.rejects(
    () => loadCustomBackends({ TASK_RUNNER_CONFIG_DIR: configDir }),
    (err) =>
      err instanceof BackendConfigError &&
      err.backendName === "bad-options" &&
      /invoke must be a function/.test(err.message) &&
      /validateSessionId must be a function/.test(err.message) &&
      /supportsBootstrapSessionImport must be a boolean/.test(err.message) &&
      /resolveConfig must be a function/.test(err.message) &&
      /launcherMode must be "applies" or "direct"/.test(err.message),
  );
});
