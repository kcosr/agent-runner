#!/usr/bin/env node
import { spawn } from "node:child_process";

const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const testScripts = ["test:node", "test:web"];

function runScript(script) {
  const child = spawn(npmCommand, ["run", script], {
    stdio: "inherit",
  });

  return new Promise((resolve) => {
    child.on("error", (error) => {
      console.error(`failed to start ${script}: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) {
        console.error(`${script} terminated by ${signal}`);
        resolve(1);
        return;
      }
      resolve(code ?? 1);
    });
  });
}

const results = await Promise.all(testScripts.map((script) => runScript(script)));
process.exit(results.every((code) => code === 0) ? 0 : 1);
