import { claudeBackend } from "./claude.js";
import { codexBackend } from "./codex.js";
import { passiveBackend } from "./passive.js";
import type { Backend } from "./types.js";

const BACKENDS: Record<string, Backend> = {
  claude: claudeBackend,
  codex: codexBackend,
  passive: passiveBackend,
};

export class UnknownBackendError extends Error {
  constructor(public readonly name: string) {
    super(`unknown backend: "${name}" (known: ${Object.keys(BACKENDS).join(", ")})`);
    this.name = "UnknownBackendError";
  }
}

export function resolveBackend(name: string): Backend {
  const backend = BACKENDS[name];
  if (!backend) throw new UnknownBackendError(name);
  return backend;
}

export function knownBackends(): string[] {
  return Object.keys(BACKENDS);
}
