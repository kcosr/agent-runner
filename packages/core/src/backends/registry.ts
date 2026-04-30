import { existsSync, readdirSync } from "node:fs";
import {
  backendFilenameCandidates,
  resolveBackendsRoot,
  resolveFirstExistingCandidate,
  resolveNamedBackendDir,
} from "../config/runtime-paths.js";
import {
  BUILTIN_BACKEND_IDS,
  type Backend,
  type BackendName,
  RESERVED_BACKEND_NAMES,
} from "../core/backends/types.js";
import { importModule } from "../util/module-loader.js";
import { claudeBackend } from "./claude.js";
import { codexBackend } from "./codex.js";
import { cursorBackend } from "./cursor.js";
import { passiveBackend } from "./passive.js";
import { piBackend } from "./pi.js";
import { isRecord } from "./shared.js";

const BUILTIN_BACKENDS: Record<string, Backend> = {
  claude: claudeBackend,
  codex: codexBackend,
  cursor: cursorBackend,
  pi: piBackend,
  passive: passiveBackend,
};

let loadedCustomBackends: Record<string, Backend> = {};
let loadedCustomBackendsRoot: string | null = null;

function activeBackends(): Record<string, Backend> {
  return {
    ...BUILTIN_BACKENDS,
    ...loadedCustomBackends,
  };
}

export class BackendConfigError extends Error {
  constructor(
    public readonly backendName: string,
    public readonly sourcePath: string,
    issues: string,
  ) {
    super(`Invalid backend "${backendName}" at ${sourcePath}:\n${issues}`);
    this.name = "BackendConfigError";
  }
}

export class UnknownBackendError extends Error {
  constructor(public readonly name: string) {
    super(`unknown backend: "${name}" (known: ${knownBackends().join(", ")})`);
    this.name = "UnknownBackendError";
  }
}

function formatIssue(issue: string): string {
  return `  - ${issue}`;
}

function resolveCustomBackendPath(name: string, env: NodeJS.ProcessEnv): string {
  const root = resolveNamedBackendDir(name, env);
  const path = resolveFirstExistingCandidate(root, backendFilenameCandidates());
  if (path) {
    return path;
  }
  throw new BackendConfigError(
    name,
    root,
    formatIssue(
      `missing backend module (expected one of ${backendFilenameCandidates().join(", ")})`,
    ),
  );
}

function validateCustomBackend(name: string, sourcePath: string, value: unknown): Backend {
  const issues: string[] = [];
  if (!isRecord(value)) {
    issues.push("default export must be an object");
  } else {
    if (typeof value.id !== "string") {
      issues.push("id must be a string");
    } else if (value.id !== name) {
      issues.push(`id must match backend directory name "${name}"`);
    }
    if (typeof value.invoke !== "function") {
      issues.push("invoke must be a function");
    }
    if (value.validateSessionId !== undefined && typeof value.validateSessionId !== "function") {
      issues.push("validateSessionId must be a function when present");
    }
    if (
      value.supportsBootstrapSessionImport !== undefined &&
      typeof value.supportsBootstrapSessionImport !== "boolean"
    ) {
      issues.push("supportsBootstrapSessionImport must be a boolean when present");
    }
    if (value.resolveConfig !== undefined && typeof value.resolveConfig !== "function") {
      issues.push("resolveConfig must be a function when present");
    }
    if (
      value.launcherMode !== undefined &&
      value.launcherMode !== "applies" &&
      value.launcherMode !== "direct"
    ) {
      issues.push('launcherMode must be "applies" or "direct" when present');
    }
  }

  if (issues.length > 0) {
    throw new BackendConfigError(name, sourcePath, issues.map(formatIssue).join("\n"));
  }
  return value as Backend;
}

async function loadCustomBackend(name: string, env: NodeJS.ProcessEnv): Promise<Backend> {
  if (RESERVED_BACKEND_NAMES.has(name)) {
    throw new BackendConfigError(
      name,
      resolveNamedBackendDir(name, env),
      formatIssue(`custom backend name is reserved (built-ins: ${BUILTIN_BACKEND_IDS.join(", ")})`),
    );
  }

  const sourcePath = resolveCustomBackendPath(name, env);
  let imported: unknown;
  try {
    imported = await importModule(sourcePath);
  } catch (error) {
    throw new BackendConfigError(
      name,
      sourcePath,
      formatIssue(
        `failed to import backend module: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }
  if (!isRecord(imported) || !("default" in imported)) {
    throw new BackendConfigError(name, sourcePath, formatIssue("default export is required"));
  }
  return { ...validateCustomBackend(name, sourcePath, imported.default), sourcePath };
}

export async function loadCustomBackends(
  env: NodeJS.ProcessEnv = process.env,
): Promise<Record<string, Backend>> {
  const root = resolveBackendsRoot(env);
  if (loadedCustomBackendsRoot === root) {
    return loadedCustomBackends;
  }
  if (!existsSync(root)) {
    loadedCustomBackends = {};
    loadedCustomBackendsRoot = root;
    return loadedCustomBackends;
  }

  const backendNames = readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name);
  const backends = await Promise.all(backendNames.map((name) => loadCustomBackend(name, env)));
  const loaded: Record<string, Backend> = {};
  for (const backend of backends) {
    loaded[backend.id] = backend;
  }
  loadedCustomBackends = loaded;
  loadedCustomBackendsRoot = root;
  return loadedCustomBackends;
}

export function resolveBackend(name: BackendName): Backend {
  const backend = activeBackends()[name];
  if (!backend) throw new UnknownBackendError(name);
  return backend;
}

export function knownBackends(): string[] {
  return Object.keys(activeBackends());
}
