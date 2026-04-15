import { strict as assert } from "node:assert";
import { test } from "node:test";
import { overridesFromParsedArgs, parseArgs } from "../apps/cli/dist/cli/parse-args.js";

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

test("parseArgs: --backend accepts cursor", () => {
  const parsed = parseArgs(argv("run", "--agent", "x", "--backend", "cursor"));
  assert.equal(parsed.backend, "cursor");
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

test("parseArgs: --connect is captured on routed commands", () => {
  const parsed = parseArgs(argv("status", "abc123", "--connect", "ws://127.0.0.1:4773/"));
  assert.equal(parsed.command, "status");
  assert.equal(parsed.connect, "ws://127.0.0.1:4773/");
});

test("parseArgs: brief captures the run id positional", () => {
  const parsed = parseArgs(argv("brief", "abc123"));
  assert.equal(parsed.command, "brief");
  assert.equal(parsed.message, "abc123");
});

test("parseArgs: serve captures --listen", () => {
  const parsed = parseArgs(argv("serve", "--listen", "ws://127.0.0.1:4773/"));
  assert.equal(parsed.command, "serve");
  assert.equal(parsed.listen, "ws://127.0.0.1:4773/");
});

test("parseArgs: list runs captures --include-archived", () => {
  const parsed = parseArgs(argv("list", "runs", "--include-archived", "--output-format", "json"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "runs");
  assert.equal(parsed.includeArchived, true);
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

test("parseArgs: task list parses grouped subcommand and output format", () => {
  const parsed = parseArgs(argv("task", "list", "abc123", "--output-format", "json"));
  assert.equal(parsed.command, "task");
  assert.equal(parsed.subcommand, "list");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: task show parses run and task ids", () => {
  const parsed = parseArgs(argv("task", "show", "abc123", "t1"));
  assert.equal(parsed.command, "task");
  assert.equal(parsed.subcommand, "show");
  assert.deepEqual(parsed.positionals, ["abc123", "t1"]);
});

test("parseArgs: task append-notes captures --text", () => {
  const parsed = parseArgs(argv("task", "append-notes", "abc123", "t1", "--text", "hello"));
  assert.equal(parsed.command, "task");
  assert.equal(parsed.subcommand, "append-notes");
  assert.deepEqual(parsed.positionals, ["abc123", "t1"]);
  assert.equal(parsed.taskAppendText, "hello");
});

test("parseArgs: task add captures optional --body", () => {
  const parsed = parseArgs(
    argv("task", "add", "abc123", "--title", "Docs", "--body", "Update the tables."),
  );
  assert.equal(parsed.command, "task");
  assert.equal(parsed.subcommand, "add");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.equal(parsed.taskTitle, "Docs");
  assert.equal(parsed.taskBody, "Update the tables.");
});

test("parseArgs: run reset parses as a grouped run subcommand", () => {
  const parsed = parseArgs(argv("run", "reset", "abc123", "--output-format", "json"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "reset");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: run archive parses as a grouped run subcommand", () => {
  const parsed = parseArgs(argv("run", "archive", "abc123", "--output-format", "json"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "archive");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: run unarchive parses as a grouped run subcommand", () => {
  const parsed = parseArgs(argv("run", "unarchive", "abc123"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "unarchive");
  assert.deepEqual(parsed.positionals, ["abc123"]);
});

test("parseArgs: run set-name parses grouped subcommand positionals and --clear", () => {
  const parsed = parseArgs(argv("run", "set-name", "abc123", "--clear", "--output-format", "json"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "set-name");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.equal(parsed.clear, true);
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: --name is captured for fresh run overrides", () => {
  const parsed = parseArgs(argv("run", "--agent", "x", "--name", "release prep"));
  assert.equal(parsed.name, "release prep");
});

test("parseArgs: --detach is captured for plain run", () => {
  const parsed = parseArgs(argv("run", "--detach", "--agent", "x"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.detach, true);
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

test("overridesFromParsedArgs: name override is plumbed through", () => {
  const parsed = parseArgs(argv("init", "--agent", "x", "--name", "repo orientation"));
  const overrides = overridesFromParsedArgs(parsed);
  assert.equal(overrides.name, "repo orientation");
});
