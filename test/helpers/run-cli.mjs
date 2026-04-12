import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { withEnv } from "./runtime-paths.mjs";

let importCounter = 0;
const CLI_PATH = resolve("dist/cli.js");

class CliExit extends Error {
  constructor(code) {
    super(`cli exited with code ${code}`);
    this.code = code;
  }
}

export async function runCli(args, opts = {}) {
  const stdout = [];
  const stderr = [];
  const priorArgv = process.argv.slice();
  const priorCwd = process.cwd();
  const stdoutWrite = process.stdout.write.bind(process.stdout);
  const stderrWrite = process.stderr.write.bind(process.stderr);
  const priorExit = process.exit;

  process.argv = ["node", CLI_PATH, ...args];
  if (opts.cwd) {
    process.chdir(opts.cwd);
  }
  process.stdout.write = (chunk) => {
    stdout.push(String(chunk));
    return true;
  };
  process.stderr.write = (chunk) => {
    stderr.push(String(chunk));
    return true;
  };
  process.exit = (code = 0) => {
    throw new CliExit(code);
  };

  let settled = false;
  let resolveExit;
  let rejectExit;
  const exitPromise = new Promise((resolvePromise, rejectPromise) => {
    resolveExit = (code) => {
      settled = true;
      resolvePromise(code);
    };
    rejectExit = (error) => {
      settled = true;
      rejectPromise(error);
    };
  });

  const onUnhandledRejection = (reason) => {
    if (reason instanceof CliExit) {
      resolveExit(reason.code);
      return;
    }
    rejectExit(reason);
  };
  const onUncaughtException = (error) => {
    if (error instanceof CliExit) {
      resolveExit(error.code);
      return;
    }
    rejectExit(error);
  };
  process.once("unhandledRejection", onUnhandledRejection);
  process.once("uncaughtException", onUncaughtException);

  const runImport = async () => {
    const cliUrl = pathToFileURL(CLI_PATH).href;
    await import(`${cliUrl}?test_run=${importCounter++}`);
  };

  let exitCode;
  try {
    if (opts.env) {
      await withEnv(opts.env, runImport);
    } else {
      await runImport();
    }
    if (!settled) {
      exitCode = await exitPromise;
    }
  } catch (error) {
    if (error instanceof CliExit) {
      exitCode = error.code;
    } else {
      throw error;
    }
  } finally {
    process.removeListener("unhandledRejection", onUnhandledRejection);
    process.removeListener("uncaughtException", onUncaughtException);
    process.argv = priorArgv;
    process.chdir(priorCwd);
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
    process.exit = priorExit;
  }

  return {
    exitCode: exitCode ?? 0,
    stdout: stdout.join(""),
    stderr: stderr.join(""),
  };
}
