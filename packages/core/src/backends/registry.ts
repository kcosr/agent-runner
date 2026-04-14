import type { Backend } from "../core/backends/types.js";
import { claudeBackend } from "./claude.js";
import { codexBackend } from "./codex.js";
import { cursorBackend } from "./cursor.js";
import { passiveBackend } from "./passive.js";

const BACKENDS: Record<string, Backend> = {
  claude: claudeBackend,
  codex: codexBackend,
  cursor: cursorBackend,
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
