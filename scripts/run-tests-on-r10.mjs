#!/usr/bin/env node
import { spawn } from "node:child_process";

const remoteHost = "r10";
const remoteDir = "task-runner";
const remoteTarget = `${remoteHost}:${remoteDir}/`;

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

const remoteCommand = [
  `cd ${remoteDir}`,
  "npm install",
  "npm run build",
  "npm run lint",
  "npm run format:check",
  "npm run imports:check",
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

let exitCode = await run("rsync", rsyncArgs);
if (exitCode === 0) {
  exitCode = await run("ssh", [remoteHost, remoteCommand]);
}

process.exit(exitCode);
