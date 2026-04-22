import { defineHook } from "../../hooks.js";
import { type RunManifest, listRunManifests } from "../run/manifest.js";
import type { TaskTransitionHookContext, TaskTransitionResult } from "./types.js";

interface RequireChildrenSuccessConfig {
  requireAny: boolean;
}

function parseConfig(config: unknown): RequireChildrenSuccessConfig {
  if (!config || typeof config !== "object") {
    throw new Error("require-children-success hook requires an object config");
  }
  const record = config as Record<string, unknown>;
  if (record.requireAny !== undefined && typeof record.requireAny !== "boolean") {
    throw new Error("require-children-success hook requireAny must be a boolean");
  }
  for (const key of Object.keys(record)) {
    if (key !== "requireAny") {
      throw new Error(`require-children-success hook does not support config key "${key}"`);
    }
  }
  return {
    requireAny: record.requireAny === true,
  };
}

function listDirectChildren(parentRunId: string): RunManifest[] {
  return listRunManifests()
    .map((entry) => entry.manifest)
    .filter((manifest) => manifest.parentRunId === parentRunId)
    .sort((left, right) => {
      const byTime = right.startedAt.localeCompare(left.startedAt);
      return byTime !== 0 ? byTime : left.runId.localeCompare(right.runId);
    });
}

function childLabel(manifest: RunManifest): string {
  const name = manifest.name ?? manifest.assignment?.name ?? null;
  return name
    ? `${manifest.runId} (${manifest.status}, ${name})`
    : `${manifest.runId} (${manifest.status})`;
}

function allChildrenSuccessful(children: readonly RunManifest[]): boolean {
  return children.every((manifest) => manifest.status === "success");
}

function buildReason(
  taskId: string,
  children: readonly RunManifest[],
  requireAny: boolean,
): string {
  if (children.length === 0) {
    return requireAny
      ? `task "${taskId}" cannot be completed because no direct child runs exist yet`
      : "";
  }
  const nonSuccessChildren = children.filter((manifest) => manifest.status !== "success");
  if (nonSuccessChildren.length === 0) {
    return "";
  }
  return `task "${taskId}" cannot be completed until all direct child runs succeed: ${nonSuccessChildren
    .map(childLabel)
    .join(", ")}`;
}

export default defineHook({
  name: "require-children-success",
  taskTransition(ctx: TaskTransitionHookContext): TaskTransitionResult {
    const config = parseConfig(ctx.config);
    if (ctx.transition.to.status !== "completed") {
      return { accept: true };
    }

    const children = listDirectChildren(ctx.run.runId);
    if (children.length === 0 && !config.requireAny) {
      return { accept: true };
    }
    if (children.length > 0 && allChildrenSuccessful(children)) {
      return { accept: true };
    }

    return {
      accept: false,
      reason: buildReason(ctx.transition.taskId, children, config.requireAny),
    };
  },
});
