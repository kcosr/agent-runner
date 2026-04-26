import { spawn } from "node:child_process";
import { Socket, createServer } from "node:net";

const SSH_READY_TIMEOUT_MS = 5000;
const SSH_READY_POLL_INTERVAL_MS = 25;
const SSH_READY_GRACE_MS = 50;
const SSH_CONNECT_TIMEOUT_MS = 250;
const SSH_STDERR_LIMIT = 8192;

export class SshTunnelSetupError extends Error {
  constructor(
    readonly host: string,
    detail: string,
  ) {
    super(`ssh tunnel setup failed for host ${host}: ${detail}`);
    this.name = "SshTunnelSetupError";
  }
}

interface SshTunnelOptions {
  host: string;
  localPort: number;
  targetHost: string;
  targetPort: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatForwardTargetHost(host: string): string {
  return host.includes(":") ? `[${host}]` : host;
}

function appendStderr(stderr: string, chunk: string): string {
  const next = stderr + chunk;
  return next.length > SSH_STDERR_LIMIT ? next.slice(-SSH_STDERR_LIMIT) : next;
}

async function canConnectToLocalPort(localPort: number): Promise<boolean> {
  try {
    await new Promise<void>((resolve, reject) => {
      const socket = new Socket();
      const cleanup = () => {
        socket.removeAllListeners();
      };
      socket.setTimeout(SSH_CONNECT_TIMEOUT_MS);
      socket.once("connect", () => {
        cleanup();
        socket.end();
        resolve();
      });
      socket.once("timeout", () => {
        cleanup();
        socket.destroy();
        reject(new Error("timed out"));
      });
      socket.once("error", (err) => {
        cleanup();
        socket.destroy();
        reject(err);
      });
      socket.connect(localPort, "127.0.0.1");
    });
    return true;
  } catch {
    return false;
  }
}

async function assertLocalPortAvailable(localPort: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const server = createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      server.close();
      if (err.code === "EADDRINUSE") {
        reject(new Error(`bind [127.0.0.1]:${localPort}: Address already in use`));
        return;
      }
      reject(err);
    });
    server.listen(localPort, "127.0.0.1", () => {
      server.close((closeErr) => {
        if (closeErr) {
          reject(closeErr);
          return;
        }
        resolve();
      });
    });
  });
}

function formatSshFailureDetail(stderr: string, fallback: string): string {
  const detail = stderr.trim();
  return detail.length > 0 ? detail : fallback;
}

export async function openSshTunnel(options: SshTunnelOptions): Promise<void> {
  try {
    await assertLocalPortAvailable(options.localPort);
  } catch (err) {
    throw new SshTunnelSetupError(options.host, err instanceof Error ? err.message : String(err));
  }

  let stderr = "";
  let spawnError: Error | undefined;
  let closed = false;
  const child = spawn(
    "ssh",
    [
      "-N",
      "-o",
      "ExitOnForwardFailure=yes",
      "-o",
      "BatchMode=yes",
      "-L",
      `127.0.0.1:${options.localPort}:${formatForwardTargetHost(options.targetHost)}:${options.targetPort}`,
      "--",
      options.host,
    ],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );

  const cleanupOnExit = () => {
    if (!closed && child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
  };
  const detachCleanupOnExit = () => {
    process.off("exit", cleanupOnExit);
  };
  process.once("exit", cleanupOnExit);
  child.once("exit", () => {
    closed = true;
    detachCleanupOnExit();
  });

  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string) => {
    stderr = appendStderr(stderr, chunk);
  });
  child.once("error", (err: Error) => {
    spawnError = err;
  });

  const fail = (detail: string): never => {
    closed = true;
    detachCleanupOnExit();
    if (child.exitCode === null && !child.killed) {
      child.kill("SIGTERM");
    }
    throw new SshTunnelSetupError(options.host, detail);
  };

  const deadline = Date.now() + SSH_READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (spawnError) {
      fail(spawnError.message);
    }
    if (child.exitCode !== null) {
      fail(formatSshFailureDetail(stderr, `ssh exited with code ${child.exitCode}`));
    }
    if (await canConnectToLocalPort(options.localPort)) {
      await sleep(SSH_READY_GRACE_MS);
      const readySpawnError = spawnError as Error | undefined;
      if (readySpawnError) {
        fail(readySpawnError.message);
      }
      if (child.exitCode !== null) {
        fail(formatSshFailureDetail(stderr, `ssh exited with code ${child.exitCode}`));
      }
      return;
    }
    await sleep(SSH_READY_POLL_INTERVAL_MS);
  }

  fail(`timed out waiting for ssh to listen on 127.0.0.1:${options.localPort}`);
}
