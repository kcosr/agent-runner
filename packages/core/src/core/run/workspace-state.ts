import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { TaskState } from "../../assignment/model.js";
import { resolveRunsRoot } from "../../config/runtime-paths.js";
import {
  type RunManifest,
  applyRunResetSeed,
  manifestPath,
  snapshotTasks,
  writeManifest,
} from "./manifest.js";

const LOCK_DIR_NAME = ".task-state.lock";
const LOCK_WAIT_MS = 10;
const LOCK_TIMEOUT_MS = 5_000;
const LOCK_WAIT_BUFFER = new Int32Array(new SharedArrayBuffer(4));
const ASYNC_LOCK_QUEUES = new Map<string, Promise<void>>();

function sleep(ms: number): void {
  Atomics.wait(LOCK_WAIT_BUFFER, 0, 0, ms);
}

function sleepAsync(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function taskLockPath(workspaceDir: string): string {
  return `${workspaceDir}/${LOCK_DIR_NAME}`;
}

function acquireFilesystemLock(lockPath: string): void {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for task-state lock at ${lockPath}`);
      }
      sleep(LOCK_WAIT_MS);
    }
  }
}

async function acquireFilesystemLockAsync(lockPath: string): Promise<void> {
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(lockPath), { recursive: true });

  while (true) {
    try {
      mkdirSync(lockPath);
      return;
    } catch (error) {
      const err = error as NodeJS.ErrnoException;
      if (err.code !== "EEXIST") {
        throw error;
      }
      if (Date.now() >= deadline) {
        throw new Error(`timed out waiting for task-state lock at ${lockPath}`);
      }
      await sleepAsync(LOCK_WAIT_MS);
    }
  }
}

function releaseFilesystemLock(lockPath: string): void {
  rmSync(lockPath, { recursive: true, force: true });
}

function withFilesystemLock<T>(lockPath: string, fn: () => T): T {
  acquireFilesystemLock(lockPath);
  try {
    return fn();
  } finally {
    releaseFilesystemLock(lockPath);
  }
}

async function withFilesystemLockAsync<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = ASYNC_LOCK_QUEUES.get(lockPath) ?? Promise.resolve();
  let releaseTurn!: () => void;
  const turn = new Promise<void>((resolve) => {
    releaseTurn = resolve;
  });
  const tail = previous.then(() => turn);
  ASYNC_LOCK_QUEUES.set(lockPath, tail);
  void tail.finally(() => {
    if (ASYNC_LOCK_QUEUES.get(lockPath) === tail) {
      ASYNC_LOCK_QUEUES.delete(lockPath);
    }
  });

  await previous;

  let locked = false;
  try {
    await acquireFilesystemLockAsync(lockPath);
    locked = true;
    return await fn();
  } finally {
    if (locked) {
      releaseFilesystemLock(lockPath);
    }
    releaseTurn();
  }
}

export function withTaskStateLock<T>(workspaceDir: string, fn: () => T): T {
  return withFilesystemLock(taskLockPath(workspaceDir), fn);
}

export function withTaskStateLockAsync<T>(workspaceDir: string, fn: () => Promise<T>): Promise<T> {
  return withFilesystemLockAsync(taskLockPath(workspaceDir), fn);
}

export function withGlobalStateLock<T>(lockName: string, fn: () => T, env?: NodeJS.ProcessEnv): T;
export function withGlobalStateLock<T>(
  lockName: string,
  fn: () => T,
  env: NodeJS.ProcessEnv = process.env,
): T {
  const runsRoot = resolveRunsRoot(env);
  mkdirSync(runsRoot, { recursive: true });
  return withFilesystemLock(join(runsRoot, `.${lockName}.lock`), fn);
}

function readManifestSnapshot(workspaceDir: string): RunManifest {
  return JSON.parse(readFileSync(manifestPath(workspaceDir), "utf8")) as RunManifest;
}

function orderedTasks(tasks: Map<string, TaskState>): TaskState[] {
  return Array.from(tasks.values());
}

export function taskMapFromManifestSnapshot(manifest: RunManifest): Map<string, TaskState> {
  const tasks = new Map<string, TaskState>();
  for (const snap of Object.values(manifest.finalTasks)) {
    tasks.set(snap.id, {
      id: snap.id,
      title: snap.title,
      body: snap.body,
      status: snap.status,
      notes: snap.notes,
    });
  }
  return tasks;
}

export function refreshManifestAttachments(manifest: RunManifest): void {
  try {
    const latest = readManifestSnapshot(manifest.workspaceDir);
    manifest.attachments = latest.attachments.map((attachment) => ({ ...attachment }));
  } catch (error) {
    const err = error as NodeJS.ErrnoException;
    if (err.code !== "ENOENT") {
      throw error;
    }
  }
}

export function refreshManifestTaskState(manifest: RunManifest): Map<string, TaskState> {
  const latest = readManifestSnapshot(manifest.workspaceDir);
  manifest.brief = latest.brief;
  manifest.finalTasks = latest.finalTasks;
  manifest.tasksCompleted = latest.tasksCompleted;
  manifest.tasksTotal = latest.tasksTotal;
  return taskMapFromManifestSnapshot(latest);
}

export function syncManifestTaskState(
  manifest: RunManifest,
  tasks: Map<string, TaskState>,
): TaskState[] {
  const ordered = orderedTasks(tasks);
  manifest.finalTasks = snapshotTasks(tasks);
  manifest.tasksCompleted = ordered.filter((task) => task.status === "completed").length;
  manifest.tasksTotal = ordered.length;
  return ordered;
}

export function loadWorkspaceTaskMap(manifest: RunManifest): Map<string, TaskState> {
  return taskMapFromManifestSnapshot(manifest);
}

export function persistWorkspaceTaskState(
  manifest: RunManifest,
  tasks: Map<string, TaskState>,
  opts: {
    beforeManifestWrite?: (ordered: TaskState[], manifest: RunManifest) => void;
    alreadyLocked?: boolean;
  } = {},
): TaskState[] {
  const persist = (): TaskState[] => {
    const ordered = syncManifestTaskState(manifest, tasks);
    opts.beforeManifestWrite?.(ordered, manifest);
    writeManifest(manifest.workspaceDir, manifest);
    return ordered;
  };

  if (opts.alreadyLocked) {
    return persist();
  }

  return withTaskStateLock(manifest.workspaceDir, persist);
}

export function resetWorkspaceRun(workspaceDir: string): RunManifest {
  return withTaskStateLock(workspaceDir, () => {
    const manifest = readManifestSnapshot(workspaceDir);
    if (manifest.status === "running") {
      throw new Error(
        "cannot reset a running run (run reset is rejected while a run is in-flight)",
      );
    }

    applyRunResetSeed(manifest);
    rmSync(join(workspaceDir, "attempts"), { recursive: true, force: true });
    persistWorkspaceTaskState(manifest, taskMapFromManifestSnapshot(manifest), {
      alreadyLocked: true,
    });
    return manifest;
  });
}
