import { listRunGroupMemberManifests } from "./groups.js";
import type { ManifestStatus, RunDependencyRef, RunManifest } from "./manifest.js";
import { deriveEffectiveStatus } from "./status.js";

export interface RunDependencyState {
  ready: boolean;
  total: number;
  satisfied: number;
  unsatisfied: number;
}

export type RunDependencyDetail =
  | {
      type: "run";
      runId: string;
      name: string | null;
      status: ManifestStatus | null;
      effectiveStatus: ManifestStatus | null;
      archivedAt: string | null;
      satisfied: boolean;
      missing: boolean;
    }
  | {
      type: "group";
      groupId: string;
      total: number;
      successful: number;
      unsatisfied: number;
      archivedExcluded: number;
      satisfied: boolean;
      missing: boolean;
    };

export type RunDependentDetail =
  | {
      type: "run";
      via: "run";
      runId: string;
      name: string | null;
      status: ManifestStatus | null;
      effectiveStatus: ManifestStatus | null;
      archivedAt: string | null;
      satisfied: boolean;
      missing: boolean;
    }
  | {
      type: "run";
      via: "group";
      runId: string;
      dependencyGroupId: string;
      name: string | null;
      status: ManifestStatus | null;
      effectiveStatus: ManifestStatus | null;
      archivedAt: string | null;
      satisfied: boolean;
      missing: boolean;
    };

export function buildRunDependencyGraph(
  manifests: Iterable<RunManifest>,
): ReadonlyMap<string, RunManifest> {
  return new Map(Array.from(manifests, (manifest) => [manifest.runId, manifest]));
}

export function dependencyRefsEqual(left: RunDependencyRef, right: RunDependencyRef): boolean {
  if (left.type === "run") {
    return right.type === "run" && left.runId === right.runId;
  }
  return right.type === "group" && left.groupId === right.groupId;
}

function toRunDependencyDetail(runId: string, manifest?: RunManifest): RunDependencyDetail {
  if (!manifest) {
    return {
      type: "run",
      runId,
      name: null,
      status: null,
      effectiveStatus: null,
      archivedAt: null,
      satisfied: false,
      missing: true,
    };
  }

  return {
    type: "run",
    runId: manifest.runId,
    name: manifest.name ?? manifest.assignment?.name ?? null,
    status: manifest.status,
    effectiveStatus: deriveEffectiveStatus(manifest),
    archivedAt: manifest.archivedAt,
    satisfied: manifest.status === "success",
    missing: false,
  };
}

function toRunDependentDetail(
  manifest: RunManifest,
  via: "run" | "group",
  dependencyGroupId?: string,
): RunDependentDetail {
  const base = {
    type: "run" as const,
    runId: manifest.runId,
    name: manifest.name ?? manifest.assignment?.name ?? null,
    status: manifest.status,
    effectiveStatus: deriveEffectiveStatus(manifest),
    archivedAt: manifest.archivedAt,
    satisfied: manifest.status === "success",
    missing: false,
  };
  if (via === "run") {
    return {
      ...base,
      via,
    };
  }
  return {
    ...base,
    via,
    dependencyGroupId: dependencyGroupId ?? manifest.runGroupId,
  };
}

function toGroupDependencyDetail(
  groupId: string,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependencyDetail {
  const members = listRunGroupMemberManifests(graph.values(), groupId, { includeArchived: true });
  const activeMembers = members.filter((member) => member.archivedAt === null);
  const successful = activeMembers.filter((member) => member.status === "success").length;
  const total = activeMembers.length;
  const unsatisfied = total - successful;
  return {
    type: "group",
    groupId,
    total,
    successful,
    unsatisfied,
    archivedExcluded: members.length - activeMembers.length,
    satisfied: total > 0 && unsatisfied === 0,
    missing: total === 0,
  };
}

export function resolveDependencyRef(
  dependency: RunDependencyRef,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependencyDetail {
  return dependency.type === "run"
    ? toRunDependencyDetail(dependency.runId, graph.get(dependency.runId))
    : toGroupDependencyDetail(dependency.groupId, graph);
}

export function deriveDependencyState(
  manifest: Pick<RunManifest, "dependencies">,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependencyState {
  return deriveDependencyStateFromDetails(resolveDependencies(manifest, graph));
}

export function deriveDependencyStateFromDetails(
  details: readonly Pick<RunDependencyDetail, "satisfied">[],
): RunDependencyState {
  const total = details.length;
  const satisfied = details.filter((detail) => detail.satisfied).length;
  const unsatisfied = total - satisfied;
  return {
    ready: unsatisfied === 0,
    total,
    satisfied,
    unsatisfied,
  };
}

export function resolveDependencies(
  manifest: Pick<RunManifest, "dependencies">,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependencyDetail[] {
  return manifest.dependencies.map((dependency) => resolveDependencyRef(dependency, graph));
}

export function resolveDependents(
  manifest: Pick<RunManifest, "runId" | "runGroupId">,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependentDetail[] {
  return Array.from(graph.values())
    .filter((candidate) => candidate.runId !== manifest.runId)
    .flatMap((candidate) =>
      candidate.dependencies.flatMap((dependency) => {
        if (dependency.type === "run" && dependency.runId === manifest.runId) {
          return [toRunDependentDetail(candidate, "run")];
        }
        if (dependency.type === "group" && dependency.groupId === manifest.runGroupId) {
          return [toRunDependentDetail(candidate, "group", dependency.groupId)];
        }
        return [];
      }),
    )
    .sort((left, right) => {
      const leftManifest = graph.get(left.runId);
      const rightManifest = graph.get(right.runId);
      const byTime = (rightManifest?.startedAt ?? "").localeCompare(leftManifest?.startedAt ?? "");
      return byTime !== 0 ? byTime : left.runId.localeCompare(right.runId);
    });
}

export function countUnsatisfiedDependencies(
  manifest: Pick<RunManifest, "dependencies">,
  graph: ReadonlyMap<string, RunManifest>,
): number {
  return deriveDependencyState(manifest, graph).unsatisfied;
}

function runNode(runId: string): string {
  return `R:${runId}`;
}

function groupNode(groupId: string): string {
  return `G:${groupId}`;
}

function dependencyNode(dependency: RunDependencyRef): string {
  return dependency.type === "run" ? runNode(dependency.runId) : groupNode(dependency.groupId);
}

function addEdge(edges: Map<string, Set<string>>, from: string, to: string): void {
  const existing = edges.get(from);
  if (existing) {
    existing.add(to);
    return;
  }
  edges.set(from, new Set([to]));
}

function buildMixedDependencyEdges(
  graph: ReadonlyMap<string, RunManifest>,
): Map<string, Set<string>> {
  const edges = new Map<string, Set<string>>();
  for (const manifest of graph.values()) {
    const run = runNode(manifest.runId);
    for (const dependency of manifest.dependencies) {
      addEdge(edges, run, dependencyNode(dependency));
    }
    if (manifest.archivedAt === null) {
      addEdge(edges, groupNode(manifest.runGroupId), run);
    }
  }
  return edges;
}

function hasPath(
  edges: ReadonlyMap<string, ReadonlySet<string>>,
  from: string,
  to: string,
): boolean {
  const stack = [from];
  const seen = new Set<string>();
  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    if (current === to) {
      return true;
    }
    seen.add(current);
    for (const next of edges.get(current) ?? []) {
      stack.push(next);
    }
  }
  return false;
}

export function wouldCreateDependencyCycle(
  graph: ReadonlyMap<string, RunManifest>,
  targetRunId: string,
  dependency: RunDependencyRef,
): boolean {
  const edges = buildMixedDependencyEdges(graph);
  const target = runNode(targetRunId);
  const dependencyTarget = dependencyNode(dependency);
  addEdge(edges, target, dependencyTarget);
  return hasPath(edges, dependencyTarget, target);
}

export function hasDependencyCycle(graph: ReadonlyMap<string, RunManifest>): boolean {
  const edges = buildMixedDependencyEdges(graph);
  for (const from of edges.keys()) {
    for (const to of edges.get(from) ?? []) {
      if (hasPath(edges, to, from)) {
        return true;
      }
    }
  }
  return false;
}
