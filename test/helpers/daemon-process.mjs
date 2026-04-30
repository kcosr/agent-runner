import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { sharedRuntimeEnv } from "./runtime-paths.mjs";

export async function freePort() {
  return await new Promise((resolve, reject) => {
    const server = createServer();
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close(() => reject(new Error("failed to allocate a test port")));
        return;
      }
      const { port } = address;
      server.close((err) => {
        if (err) reject(err);
        else resolve(port);
      });
    });
  });
}

export async function startCliDaemon(baseDir, listenUrl, cliPath, opts = {}) {
  const child = spawn("node", [cliPath, "serve", "--listen", listenUrl], {
    cwd: baseDir,
    env: { ...process.env, ...sharedRuntimeEnv(baseDir), ...(opts.env ?? {}) },
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stderr = "";
  await new Promise((resolve, reject) => {
    const timeoutMs = opts.timeoutMs ?? 5_000;
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      child.kill("SIGTERM");
      reject(new Error(`daemon did not become ready: ${stderr}`));
    }, timeoutMs);
    const onExit = (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`daemon exited before ready (code=${code} signal=${signal}): ${stderr}`));
    };
    child.once("exit", onExit);
    child.once("error", (error) => {
      clearTimeout(timeout);
      child.off("exit", onExit);
      reject(error);
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
      if (stderr.includes("serving on")) {
        clearTimeout(timeout);
        child.off("exit", onExit);
        resolve();
      }
    });
  });

  return {
    child,
    async stop(signal = "SIGINT") {
      if (child.exitCode !== null) {
        return { code: child.exitCode, signal: child.signalCode };
      }
      child.kill(signal);
      return await new Promise((resolve) =>
        child.once("exit", (code, exitSignal) => resolve({ code, signal: exitSignal })),
      );
    },
  };
}
