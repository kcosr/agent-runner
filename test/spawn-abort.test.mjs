import { strict as assert } from "node:assert";
import { test } from "node:test";
import { buildSpawnCommand, runProcess } from "../packages/core/dist/util/spawn.js";

test("buildSpawnCommand preserves direct execution and wraps prefix launchers exactly once", () => {
  assert.deepEqual(
    buildSpawnCommand({
      command: "claude",
      args: ["--print", "hi"],
      launcher: { kind: "direct", name: "direct" },
    }),
    {
      command: "claude",
      args: ["--print", "hi"],
    },
  );
  assert.deepEqual(
    buildSpawnCommand({
      command: "cursor-agent",
      args: ["-p", "prompt"],
      launcher: {
        kind: "prefix",
        command: "ssh",
        args: ["worker", "--"],
        name: "ssh-worker",
        source: "named",
      },
    }),
    {
      command: "ssh",
      args: ["worker", "--", "cursor-agent", "-p", "prompt"],
    },
  );
});

test("runProcess: aborting before spawn marks aborted and kills the child", async () => {
  const controller = new AbortController();
  // Sleep for a long time — should be killed by abort.
  const startedAt = Date.now();
  setTimeout(() => controller.abort(), 100);
  const result = await runProcess({
    command: "sleep",
    args: ["30"],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 60_000,
    abortSignal: controller.signal,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 10_000, `aborted child should die fast, took ${elapsed}ms`);
  assert.equal(result.aborted, true, "aborted flag set");
  assert.equal(result.timedOut, false, "not a timeout");
  // Child was killed by SIGINT, not exit normally.
  assert.ok(result.signal !== null || result.exitCode !== 0, "did not exit cleanly");
});

test("runProcess: pre-aborted signal kills child immediately", async () => {
  const controller = new AbortController();
  controller.abort();
  const startedAt = Date.now();
  const result = await runProcess({
    command: "sleep",
    args: ["30"],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 60_000,
    abortSignal: controller.signal,
  });
  const elapsed = Date.now() - startedAt;
  assert.ok(elapsed < 10_000, `pre-aborted child should die fast, took ${elapsed}ms`);
  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
});

test("runProcess: pre-aborted signal does not attempt to spawn the command", async () => {
  const controller = new AbortController();
  controller.abort();

  const result = await runProcess({
    command: "definitely-not-a-real-command",
    args: [],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 60_000,
    abortSignal: controller.signal,
  });

  assert.equal(result.aborted, true);
  assert.equal(result.exitCode, null);
  assert.equal(result.signal, null);
  assert.equal(result.stderrText, "");
});

test("runProcess: normal exit reports aborted: false", async () => {
  const result = await runProcess({
    command: "true",
    args: [],
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 5_000,
  });
  assert.equal(result.aborted, false);
  assert.equal(result.exitCode, 0);
});

test("runProcess: launcher-wrapped commands preserve abort handling", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  const result = await runProcess({
    command: "sleep",
    args: ["30"],
    launcher: {
      kind: "prefix",
      command: "env",
      args: [],
      name: "env-wrap",
      source: "named",
    },
    cwd: process.cwd(),
    env: { ...process.env },
    timeoutMs: 60_000,
    abortSignal: controller.signal,
  });
  assert.equal(result.aborted, true);
  assert.equal(result.timedOut, false);
  assert.ok(result.signal !== null || result.exitCode !== 0);
});
