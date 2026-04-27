#!/usr/bin/env node
import { spawn } from "node:child_process";

const mode = process.argv[2];
const remoteHost = process.env.TASK_RUNNER_TEST_REMOTE_HOST?.trim() ?? "";
const remoteDir = process.env.TASK_RUNNER_TEST_REMOTE_DIR?.trim() || "task-runner";
const remoteTarget = `${remoteHost}:${remoteDir}/`;
const localTestScript = "scripts/run-tests-concurrently.mjs";
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

if (mode !== "test" && mode !== "check") {
  console.error("usage: node scripts/run-verification.mjs <test|check>");
  process.exit(1);
}

if (remoteHost && !/^[A-Za-z0-9._@-]+$/.test(remoteHost)) {
  console.error("TASK_RUNNER_TEST_REMOTE_HOST may contain only letters, numbers, ., _, @, or -");
  process.exit(1);
}

if (!/^[A-Za-z0-9._~/-]+$/.test(remoteDir)) {
  console.error("TASK_RUNNER_TEST_REMOTE_DIR may contain only letters, numbers, ., _, ~, /, or -");
  process.exit(1);
}

const rsyncArgs = [
  "-a",
  "--delete",
  "--exclude",
  ".git",
  "--exclude",
  "node_modules",
  "--exclude",
  "apps/*/dist",
  "--exclude",
  "packages/*/dist",
  "--exclude",
  "apps/*/tsconfig.tsbuildinfo",
  "--exclude",
  "packages/*/tsconfig.tsbuildinfo",
  `${process.cwd()}/`,
  remoteTarget,
];

const localCommands = [
  ["run", "build"],
  ...(mode === "check"
    ? [
        ["run", "lint"],
        ["run", "format:check"],
        ["run", "imports:check"],
      ]
    : []),
  [process.execPath, localTestScript],
];

function shellQuote(value) {
  return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

const remoteCommand = [
  `cd ${shellQuote(remoteDir)}`,
  "npm install",
  "npm run build",
  ...(mode === "check" ? ["npm run lint", "npm run format:check", "npm run imports:check"] : []),
  'node --test --test-reporter=dot "test/**/*.test.mjs"',
  "npm run test:web",
].join(" && ");

function run(command, args) {
  const child = spawn(command, args, { stdio: "inherit" });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`failed to start ${command}: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`${command} terminated by ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

if (!remoteHost) {
  for (const command of localCommands) {
    const [executable, ...args] =
      command[0] === process.execPath ? command : [npmCommand, ...command];
    const exitCode = await run(executable, args);
    if (exitCode !== 0) {
      process.exit(exitCode);
    }
  }
  process.exit(0);
}

let exitCode = await run("rsync", rsyncArgs);
if (exitCode === 0) {
  exitCode = await run("ssh", [remoteHost, remoteCommand]);
}

process.exit(exitCode);
