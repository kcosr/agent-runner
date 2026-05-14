#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { argv, env, exit, stderr, stdin, stdout } from "node:process";
import { createInterface } from "node:readline/promises";

function usage() {
  return [
    "Usage: node scripts/task-list-markdown.mjs [run-id]",
    "",
    "Renders `agent-runner task list <run-id> --output-format json` as Markdown.",
    "Uses `agent-runner` from PATH by default.",
    "Set AGENT_RUNNER_BIN to override the executable path.",
  ].join("\n");
}

async function promptForRunId() {
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    return (await rl.question("Run id: ")).trim();
  } finally {
    rl.close();
  }
}

function renderSection(body) {
  const trimmed = body.trim();
  return trimmed.length > 0 ? trimmed : "_None_";
}

function renderMarkdown(tasks) {
  return `${tasks
    .map((task, index) =>
      [
        `## ${index + 1}. ${task.title}`,
        "",
        "### Instructions",
        "",
        renderSection(task.body),
        "",
        "### Notes",
        "",
        renderSection(task.notes),
      ].join("\n"),
    )
    .join("\n\n")}\n`;
}

async function main() {
  const args = argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    stdout.write(`${usage()}\n`);
    exit(0);
  }

  const runId = (args[0] ?? (await promptForRunId())).trim();
  if (!runId) {
    stderr.write(`task-list-markdown: missing run id\n${usage()}\n`);
    exit(2);
  }

  const agentRunnerBin = env.AGENT_RUNNER_BIN?.trim() || "agent-runner";

  let rawJson;
  try {
    rawJson = execFileSync(agentRunnerBin, ["task", "list", runId, "--output-format", "json"], {
      encoding: "utf8",
    });
  } catch (error) {
    if (typeof error.stderr === "string" && error.stderr.length > 0) {
      stderr.write(error.stderr);
    } else {
      stderr.write(`task-list-markdown: failed to run ${agentRunnerBin}: ${error.message}\n`);
    }
    exit(error.status ?? 1);
  }

  let tasks;
  try {
    tasks = JSON.parse(rawJson);
  } catch (error) {
    stderr.write(`task-list-markdown: invalid JSON from ${agentRunnerBin}: ${error.message}\n`);
    exit(1);
  }

  if (!Array.isArray(tasks)) {
    stderr.write("task-list-markdown: expected a JSON array of tasks\n");
    exit(1);
  }

  stdout.write(renderMarkdown(tasks));
}

await main();
