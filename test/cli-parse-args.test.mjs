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

test("parseArgs: backend arg override flags are not supported", () => {
  assert.throws(
    () => parseArgs(argv("run", "--agent", "x", "--backend-arg", "--flag")),
    /Unknown flag: --backend-arg/,
  );
  assert.equal(
    "backendArgs" in overridesFromParsedArgs(parseArgs(argv("run", "--agent", "x"))),
    false,
  );
});

test("parseArgs: --parent-run captures a fresh-run lineage parent", () => {
  const parsed = parseArgs(argv("run", "--agent", "x", "--parent-run", "parent-123"));
  assert.equal(parsed.parentRun, "parent-123");
});

test("parseArgs: --parent-run requires a non-empty value", () => {
  assert.throws(() => parseArgs(argv("run", "--agent", "x", "--parent-run")), /requires a value/);
  assert.throws(
    () => parseArgs(argv("run", "--agent", "x", "--parent-run", "   ")),
    /cannot be empty/,
  );
});

test("parseArgs: --launcher captures the launcher override and forwards it into overrides", () => {
  const parsed = parseArgs(argv("run", "--agent", "x", "--launcher", "./launchers/ssh.yaml"));
  assert.equal(parsed.launcher, "./launchers/ssh.yaml");
  assert.equal(overridesFromParsedArgs(parsed).launcher, "./launchers/ssh.yaml");
});

test("parseArgs: --environment captures the execution environment override", () => {
  const parsed = parseArgs(argv("run", "--agent", "x", "--environment", "dev-container"));
  assert.equal(parsed.environment, "dev-container");
  assert.equal(overridesFromParsedArgs(parsed).executionEnvironment, "dev-container");
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

test("parseArgs: top-level status captures --connect without a run id", () => {
  const parsed = parseArgs(argv("status", "--connect", "ws://127.0.0.1:4773/"));
  assert.equal(parsed.command, "status");
  assert.equal(parsed.connect, "ws://127.0.0.1:4773/");
});

test("parseArgs: captures --connect-host and --connect-local-port", () => {
  const parsed = parseArgs(
    argv(
      "status",
      "--connect",
      "ws://127.0.0.1:4773/",
      "--connect-host",
      "prod-box",
      "--connect-local-port",
      "5773",
    ),
  );
  assert.equal(parsed.connectHost, "prod-box");
  assert.equal(parsed.connectLocalPort, "5773");
});

test("parseArgs: --connect-host and --connect-local-port require values", () => {
  assert.throws(() => parseArgs(argv("status", "--connect-host")), /requires a value/);
  assert.throws(() => parseArgs(argv("status", "--connect-local-port")), /requires a value/);
});

test("parseArgs: run status parses as a grouped run subcommand", () => {
  const parsed = parseArgs(argv("run", "status", "abc123", "--field", "tasks"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "status");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.deepEqual(parsed.fields, ["tasks"]);
});

test("parseArgs: run brief parses as a grouped run subcommand", () => {
  const parsed = parseArgs(argv("run", "brief", "abc123"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "brief");
  assert.deepEqual(parsed.positionals, ["abc123"]);
});

test("parseArgs: run reconfigure parses run id, vars, message file, and output format", () => {
  const parsed = parseArgs(
    argv(
      "run",
      "reconfigure",
      "abc123",
      "--var",
      "branch=main",
      "--message-file",
      "/tmp/brief.md",
      "--output-format",
      "json",
    ),
  );
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "reconfigure");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.deepEqual(parsed.vars, { branch: "main" });
  assert.equal(parsed.messageFile, "/tmp/brief.md");
  assert.equal(parsed.message, undefined);
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: run reconfigure joins message tokens after the run id", () => {
  const parsed = parseArgs(argv("run", "reconfigure", "abc123", "replace", "the", "brief"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "reconfigure");
  assert.deepEqual(parsed.positionals, ["abc123", "replace", "the", "brief"]);
  assert.equal(parsed.message, "replace the brief");
});

test("parseArgs: queued resume run subcommands parse as grouped commands", () => {
  const queued = parseArgs(argv("run", "queue-message", "abc123", "check", "logs"));
  assert.equal(queued.command, "run");
  assert.equal(queued.subcommand, "queue-message");
  assert.deepEqual(queued.positionals, ["abc123", "check", "logs"]);
  assert.equal(queued.message, "check logs");

  const listed = parseArgs(argv("run", "queued-messages", "abc123", "--output-format", "json"));
  assert.equal(listed.subcommand, "queued-messages");
  assert.deepEqual(listed.positionals, ["abc123"]);
  assert.equal(listed.outputFormat, "json");

  const removed = parseArgs(argv("run", "remove-queued-message", "abc123", "qmsg123"));
  assert.equal(removed.subcommand, "remove-queued-message");
  assert.deepEqual(removed.positionals, ["abc123", "qmsg123"]);
});

test("parseArgs: run audit parses grouped subcommand and --limit", () => {
  const parsed = parseArgs(
    argv("run", "audit", "abc123", "--limit", "25", "--output-format", "json"),
  );
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "audit");
  assert.deepEqual(parsed.positionals, ["abc123"]);
  assert.equal(parsed.limit, 25);
  assert.equal(parsed.outputFormat, "json");
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

test("parseArgs: list runs captures --cwd scope", () => {
  const parsed = parseArgs(argv("list", "runs", "--cwd", "../other"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "runs");
  assert.equal(parsed.cwd, "../other");
});

test("parseArgs: list runs captures --repo scope", () => {
  const parsed = parseArgs(argv("list", "runs", "--repo", "assistant"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "runs");
  assert.equal(parsed.repo, "assistant");
});

test("parseArgs: list runs captures --global scope", () => {
  const parsed = parseArgs(argv("list", "runs", "--global"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "runs");
  assert.equal(parsed.global, true);
});

test("parseArgs: list runs captures --group-id scope", () => {
  const parsed = parseArgs(argv("list", "runs", "--group-id", "group-123"));
  assert.equal(parsed.command, "list");
  assert.equal(parsed.subcommand, "runs");
  assert.equal(parsed.groupId, "group-123");
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

test("parseArgs: run set-backend-session parses grouped subcommand positionals", () => {
  const parsed = parseArgs(
    argv("run", "set-backend-session", "abc123", "thread-42", "--output-format", "json"),
  );
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "set-backend-session");
  assert.deepEqual(parsed.positionals, ["abc123", "thread-42"]);
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: run clear-backend-session parses as a grouped run subcommand", () => {
  const parsed = parseArgs(argv("run", "clear-backend-session", "abc123"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "clear-backend-session");
  assert.deepEqual(parsed.positionals, ["abc123"]);
});

test("parseArgs: run set-note parses grouped subcommand positionals and note text", () => {
  const parsed = parseArgs(
    argv("run", "set-note", "abc123", "Keep the pinned filter on", "--output-format", "json"),
  );
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "set-note");
  assert.deepEqual(parsed.positionals, ["abc123", "Keep the pinned filter on"]);
  assert.equal(parsed.outputFormat, "json");
});

test("parseArgs: run clear-note parses as a grouped run subcommand", () => {
  const parsed = parseArgs(argv("run", "clear-note", "abc123"));
  assert.equal(parsed.command, "run");
  assert.equal(parsed.subcommand, "clear-note");
  assert.deepEqual(parsed.positionals, ["abc123"]);
});

test("parseArgs: run pin and run unpin parse as grouped run subcommands", () => {
  const pin = parseArgs(argv("run", "pin", "abc123", "--output-format", "json"));
  assert.equal(pin.command, "run");
  assert.equal(pin.subcommand, "pin");
  assert.deepEqual(pin.positionals, ["abc123"]);
  assert.equal(pin.outputFormat, "json");

  const unpin = parseArgs(argv("run", "unpin", "abc123"));
  assert.equal(unpin.command, "run");
  assert.equal(unpin.subcommand, "unpin");
  assert.deepEqual(unpin.positionals, ["abc123"]);
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
