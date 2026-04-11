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
