import { strict as assert } from "node:assert";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildClaudeArgs, claudeBackend } from "../packages/core/dist/backends/claude.js";
import { withEnv } from "./helpers/runtime-paths.mjs";

function tempDir() {
  return mkdtempSync(join(tmpdir(), "agent-runner-claude-"));
}

function writeFakeClaudeBin(baseDir) {
  const path = join(baseDir, "fake-claude.mjs");
  writeFileSync(
    path,
    `#!/usr/bin/env node
import { writeFileSync } from "node:fs";

if (process.env.CLAUDE_TEST_ARGS_PATH) {
  writeFileSync(process.env.CLAUDE_TEST_ARGS_PATH, JSON.stringify(process.argv.slice(2)));
}

for (const chunk of JSON.parse(process.env.CLAUDE_TEST_STDOUT_JSON ?? "[]")) {
  process.stdout.write(chunk);
}
for (const chunk of JSON.parse(process.env.CLAUDE_TEST_STDERR_JSON ?? "[]")) {
  process.stderr.write(chunk);
}

process.exit(Number(process.env.CLAUDE_TEST_EXIT_CODE ?? "0"));
`,
  );
  chmodSync(path, 0o755);
  return path;
}

test("buildClaudeArgs builds print-mode stream-json argv", () => {
  assert.deepEqual(
    buildClaudeArgs({
      prompt: "Inspect the repo",
      model: "anthropic/claude-opus-4-7",
      effort: "xhigh",
      name: "Claude invoke name",
      resolvedBackendArgs: ["--append-system-prompt", "extra"],
      resumeSessionId: "claude-prev-session",
      unrestricted: true,
    }),
    [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-opus-4-7",
      "--effort",
      "max",
      "--dangerously-skip-permissions",
      "--name",
      "Claude invoke name",
      "--resume",
      "claude-prev-session",
      "--append-system-prompt",
      "extra",
      "Inspect the repo",
    ],
  );
});

test("claude backend captures raw stdout before lenient stream-json parsing", async () => {
  const dir = tempDir();
  const argsPath = join(dir, "args.json");
  const command = writeFakeClaudeBin(dir);
  const rawStdoutLines = [];
  const events = [];

  try {
    const result = await withEnv({ AGENT_RUNNER_CLAUDE_BIN: command }, () =>
      claudeBackend.invoke({
        prompt: "Inspect the repo",
        cwd: dir,
        env: {
          ...process.env,
          CLAUDE_TEST_ARGS_PATH: argsPath,
          CLAUDE_TEST_STDOUT_JSON: JSON.stringify([
            "not-json\n",
            `${JSON.stringify({
              type: "stream_event",
              event: {
                type: "content_block_delta",
                delta: { type: "text_delta", text: "Hello" },
              },
            })}\r\n`,
            `${JSON.stringify({ type: "result", result: "Final answer", session_id: "sess-123" })}\n`,
            "tail-partial",
          ]),
        },
        model: "anthropic/claude-opus-4-7",
        effort: "xhigh",
        name: "Claude invoke name",
        resolvedBackendArgs: ["--append-system-prompt", "extra"],
        unrestricted: true,
        timeoutSec: 10,
        resumeSessionId: "claude-prev-session",
        emit: (event) => events.push(event),
        onRawStdoutLine: (line) => rawStdoutLines.push(line),
      }),
    );

    assert.deepEqual(JSON.parse(readFileSync(argsPath, "utf8")), [
      "--print",
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      "claude-opus-4-7",
      "--effort",
      "max",
      "--dangerously-skip-permissions",
      "--name",
      "Claude invoke name",
      "--resume",
      "claude-prev-session",
      "--append-system-prompt",
      "extra",
      "Inspect the repo",
    ]);
    assert.equal(result.exitCode, 0, `${result.rawStderr}\n${result.rawStdout}`);
    assert.equal(result.sessionId, "sess-123");
    assert.equal(result.transcript, "Hello\n\n---\n\nFinal answer");
    assert.deepEqual(rawStdoutLines, [
      "not-json\n",
      `${JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          delta: { type: "text_delta", text: "Hello" },
        },
      })}\r\n`,
      `${JSON.stringify({ type: "result", result: "Final answer", session_id: "sess-123" })}\n`,
      "tail-partial",
    ]);
    assert.deepEqual(
      events.filter((event) => event.type === "agent_message_delta").map((event) => event.text),
      ["Hello"],
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
