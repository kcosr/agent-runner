import { strict as assert } from "node:assert";
import { test } from "node:test";
import { overridesFromParsedArgs, parseArgs } from "../dist/cli/parse-args.js";

function argv(...rest) {
  return ["node", "task-runner", ...rest];
}

test("parseArgs: bare --add-task flag collects title", () => {
  const parsed = parseArgs(argv("run", "--agent", "x", "--add-task", "Check the logs"));
  assert.deepEqual(parsed.addedTasks, ["Check the logs"]);
});

test("parseArgs: repeated --add-task preserves order", () => {
  const parsed = parseArgs(
    argv(
      "run",
      "--agent",
      "x",
      "--add-task",
      "first",
      "--add-task",
      "second",
      "--add-task",
      "third",
    ),
  );
  assert.deepEqual(parsed.addedTasks, ["first", "second", "third"]);
});

test("parseArgs: --add-task mixed with positional message", () => {
  const parsed = parseArgs(
    argv(
      "run",
      "--resume-run",
      "abc123",
      "--agent",
      "basic",
      "--var",
      "repo_path=.",
      "What was the magic number?",
      "--add-task",
      "run ls",
    ),
  );
  assert.deepEqual(parsed.addedTasks, ["run ls"]);
  assert.equal(parsed.message, "What was the magic number?");
  assert.equal(parsed.resumeRun, "abc123");
  assert.equal(parsed.vars.repo_path, ".");
});

test("parseArgs: --add-task without value throws", () => {
  assert.throws(
    () => parseArgs(argv("run", "--agent", "x", "--add-task")),
    /requires a task title/,
  );
});

test("parseArgs: empty addedTasks stays empty", () => {
  const parsed = parseArgs(argv("run", "--agent", "x"));
  assert.deepEqual(parsed.addedTasks, []);
});

test("overridesFromParsedArgs: addedTasks populated when non-empty", () => {
  const parsed = parseArgs(argv("run", "--agent", "x", "--add-task", "hello"));
  const overrides = overridesFromParsedArgs(parsed);
  assert.deepEqual(overrides.addedTasks, ["hello"]);
});

test("overridesFromParsedArgs: addedTasks is undefined when empty (so locked-field check skips)", () => {
  const parsed = parseArgs(argv("run", "--agent", "x"));
  const overrides = overridesFromParsedArgs(parsed);
  assert.equal(overrides.addedTasks, undefined);
});

// ── list/show command parsing ────────────────────────────────────────

test("parseArgs: list agents is parsed as command=list subcommand=agents", () => {
  const parsed = parseArgs(argv("list", "agents"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "agents");
});

test("parseArgs: list assignments is parsed as command=list subcommand=assignments", () => {
  const parsed = parseArgs(argv("list", "assignments"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "assignments");
});

test("parseArgs: list with --output-format json", () => {
  const parsed = parseArgs(argv("list", "agents", "--output-format", "json"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "agents");
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: list with no kind still parses (validation in handler)", () => {
  const parsed = parseArgs(argv("list"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, undefined);
});

test("parseArgs: show agent parses with positional target", () => {
  const parsed = parseArgs(argv("show", "agent", "example"));
  assert.equal(parsed.command, "show");
  assert.equal(parsed.subcommand, "agent");
  assert.deepEqual(parsed.positionals, ["example"]);
});

test("parseArgs: show assignment parses with positional target", () => {
  const parsed = parseArgs(argv("show", "assignment", "repo-orientation"));
  assert.equal(parsed.command, "show");
  assert.equal(parsed.subcommand, "assignment");
  assert.deepEqual(parsed.positionals, ["repo-orientation"]);
});

test("parseArgs: show agent with --output-format json", () => {
  const parsed = parseArgs(argv("show", "agent", "example", "--output-format", "json"));
  assert.equal(parsed.command, "show");
  assert.equal(parsed.subcommand, "agent");
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: show with no kind still parses (validation in handler)", () => {
  const parsed = parseArgs(argv("show"));
  assert.equal(parsed.command, "show");
  assert.equal(parsed.subcommand, undefined);
});

test("parseArgs: show agent with path positional", () => {
  const parsed = parseArgs(argv("show", "agent", "./agents/example/agent.md"));
  assert.equal(parsed.command, "show");
  assert.equal(parsed.subcommand, "agent");
  assert.deepEqual(parsed.positionals, ["./agents/example/agent.md"]);
});

test("overridesFromParsedArgs: all other overrides plumbed through", () => {
  const parsed = parseArgs(
    argv(
      "run",
      "--agent",
      "x",
      "--model",
      "claude-opus-4-6",
      "--effort",
      "max",
      "--timeout-sec",
      "60",
      "--max-retries",
      "5",
      "--unrestricted",
      "hello there",
    ),
  );
  const overrides = overridesFromParsedArgs(parsed);
  assert.equal(overrides.model, "claude-opus-4-6");
  assert.equal(overrides.effort, "max");
  assert.equal(overrides.timeoutSec, 60);
  assert.equal(overrides.maxRetries, 5);
  assert.equal(overrides.unrestricted, true);
  assert.equal(overrides.message, "hello there");
});
