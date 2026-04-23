import { existsSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import { createJiti } from "jiti";
import {
  hookFilenameCandidates,
  resolveNamedHookDir,
  resolveTaskRunnerConfigDir,
} from "../../config/runtime-paths.js";
import type { LoadedAssignment } from "../config/loaded.js";
import type { HookPhase } from "../config/schema.js";
import { builtinHookModule } from "./registry.js";
import type {
  HookModule,
  HookWhen,
  ResolvedHookDescriptor,
  TaskTransitionHookWhen,
} from "./types.js";

export class HookConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HookConfigError";
  }
}

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
});

function interpolateHookValue(value: unknown, vars: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    return value.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawKey) => {
      const key = String(rawKey).trim();
      const resolved = vars[key];
      return resolved === undefined || resolved === null ? "" : String(resolved);
    });
  }
  if (Array.isArray(value)) {
    return value.map((item) => interpolateHookValue(item, vars));
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, interpolateHookValue(entry, vars)]),
    );
  }
  return value;
}

function resolveNamedHookPath(id: string, env: NodeJS.ProcessEnv): string {
  const root = resolveNamedHookDir(id, env);
  for (const candidate of hookFilenameCandidates()) {
    const path = resolve(root, candidate);
    if (existsSync(path)) {
      return path;
    }
  }
  throw new HookConfigError(
    `hook "${id}" was not found under ${root} (expected one of ${hookFilenameCandidates().join(", ")})`,
  );
}

function resolvePathHookPath(path: string, assignment: LoadedAssignment): string {
  const baseDir = resolve(assignment.sourcePath, "..");
  const resolvedPath = isAbsolute(path) ? path : resolve(baseDir, path);
  if (!existsSync(resolvedPath)) {
    throw new HookConfigError(`hook path ${resolvedPath} was not found`);
  }
  return resolvedPath;
}

function hookSourceLabel(descriptor: ResolvedHookDescriptor): string {
  if (descriptor.source.builtin) {
    return `builtin:${descriptor.source.builtin}`;
  }
  if (descriptor.source.name) {
    return `name:${descriptor.source.name}`;
  }
  return `path:${descriptor.source.path ?? descriptor.resolvedPath ?? "<unknown>"}`;
}

function validateTaskScopedWhen(
  phase: HookPhase,
  index: number,
  taskScopeId: string | null,
  when: HookWhen | null,
): void {
  if (phase !== "taskTransition" || taskScopeId === null || when === null) {
    return;
  }
  const taskWhen = when as TaskTransitionHookWhen;
  if (taskWhen.taskId !== undefined && taskWhen.taskId !== taskScopeId) {
    throw new HookConfigError(
      `task hook taskTransition[${index}] for task "${taskScopeId}" cannot target when.taskId "${taskWhen.taskId}"`,
    );
  }
  if (taskWhen.taskIds?.some((taskId) => taskId !== taskScopeId)) {
    throw new HookConfigError(
      `task hook taskTransition[${index}] for task "${taskScopeId}" cannot target taskIds outside its task scope`,
    );
  }
}

export function resolveAssignmentHooks(
  assignment: LoadedAssignment | undefined,
  vars: Record<string, unknown>,
  env: NodeJS.ProcessEnv = process.env,
): ResolvedHookDescriptor[] {
  if (!assignment) {
    return [];
  }

  const descriptors: ResolvedHookDescriptor[] = [];
  const configDir = resolveTaskRunnerConfigDir(env);
  const pushResolvedDescriptor = (
    phase: HookPhase,
    index: number,
    entry: {
      builtin?: string;
      name?: string;
      path?: string;
      when?: unknown;
      with?: unknown;
    },
    scope: {
      taskScopeId?: string;
      hookIdPrefix?: string;
    } = {},
  ) => {
    const config = interpolateHookValue(entry.with, vars);
    const when = interpolateHookValue(entry.when ?? null, vars) as HookWhen | null;
    const scopeTaskId = scope.taskScopeId ?? null;
    validateTaskScopedWhen(phase, index, scopeTaskId, when);
    const hookIdPrefix = scope.hookIdPrefix ? `${scope.hookIdPrefix}:` : "";
    if (entry.builtin) {
      descriptors.push({
        hookId: `${phase}:${hookIdPrefix}${index}:${entry.builtin}`,
        phase,
        source: { builtin: entry.builtin },
        resolvedPath: null,
        taskScopeId: scopeTaskId,
        when,
        config,
      });
      return;
    }
    if (entry.name) {
      descriptors.push({
        hookId: `${phase}:${hookIdPrefix}${index}:${entry.name}`,
        phase,
        source: { name: entry.name, path: `${configDir}/hooks/${entry.name}` },
        resolvedPath: resolveNamedHookPath(entry.name, env),
        taskScopeId: scopeTaskId,
        when,
        config,
      });
      return;
    }
    if (!entry.path) {
      throw new HookConfigError(`hook ${phase}[${index}] is missing a hook source`);
    }
    descriptors.push({
      hookId: `${phase}:${hookIdPrefix}${index}:${entry.path}`,
      phase,
      source: { path: entry.path },
      resolvedPath: resolvePathHookPath(
        interpolateHookValue(entry.path, vars) as string,
        assignment,
      ),
      taskScopeId: scopeTaskId,
      when,
      config,
    });
  };

  assignment.config.tasks.forEach((task) => {
    task.hooks.forEach((entry, index) => {
      pushResolvedDescriptor("taskTransition", index, entry, {
        taskScopeId: task.id,
        hookIdPrefix: `task:${task.id}`,
      });
    });
  });

  for (const phase of Object.keys(assignment.config.hooks) as HookPhase[]) {
    const entries = assignment.config.hooks[phase];
    entries.forEach((entry, index) => {
      pushResolvedDescriptor(phase, index, entry);
    });
  }
  return descriptors;
}

export async function loadHookModule(descriptor: ResolvedHookDescriptor): Promise<HookModule> {
  if (descriptor.source.builtin) {
    return builtinHookModule(descriptor.source.builtin);
  }
  if (!descriptor.resolvedPath) {
    throw new HookConfigError(
      `hook ${hookSourceLabel(descriptor)} did not resolve to a module path`,
    );
  }
  const imported = (await jiti.import(descriptor.resolvedPath)) as
    | HookModule
    | { default?: HookModule };
  const hook =
    "default" in imported && imported.default ? imported.default : (imported as HookModule);
  if (!hook || typeof hook !== "object" || typeof hook.name !== "string") {
    throw new HookConfigError(
      `hook ${hookSourceLabel(descriptor)} must export a default hook object with a string name`,
    );
  }
  return hook;
}
