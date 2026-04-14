import type { ManifestStatus, RunManifest } from "./manifest.js";
import { deriveEffectiveStatus } from "./status.js";

export interface RunDependencyState {
  ready: boolean;
  total: number;
  satisfied: number;
  unsatisfied: number;
}

export interface RunDependencyDetail {
  runId: string;
  name: string | null;
  status: ManifestStatus | null;
  effectiveStatus: ManifestStatus | null;
  archivedAt: string | null;
  satisfied: boolean;
  missing: boolean;
}

export function buildRunDependencyGraph(
  manifests: Iterable<RunManifest>,
): ReadonlyMap<string, RunManifest> {
  return new Map(Array.from(manifests, (manifest) => [manifest.runId, manifest]));
}

export function toRunDependencyDetail(runId: string, manifest?: RunManifest): RunDependencyDetail {
  if (!manifest) {
    return {
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
    runId: manifest.runId,
    name: manifest.name ?? manifest.assignment?.name ?? null,
    status: manifest.status,
    effectiveStatus: deriveEffectiveStatus(manifest),
    archivedAt: manifest.archivedAt,
    satisfied: manifest.status === "success",
    missing: false,
  };
}

export function deriveDependencyState(
  manifest: Pick<RunManifest, "dependencyRunIds">,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependencyState {
  const successfulRunIds = new Set<string>();
  for (const candidate of graph.values()) {
    if (candidate.status === "success") {
      successfulRunIds.add(candidate.runId);
    }
  }
  return deriveDependencyStateFromSatisfiedRunIds(manifest, successfulRunIds);
}

export function deriveDependencyStateFromSatisfiedRunIds(
  manifest: Pick<RunManifest, "dependencyRunIds">,
  satisfiedRunIds: ReadonlySet<string>,
): RunDependencyState {
  const total = manifest.dependencyRunIds.length;
  const satisfied = manifest.dependencyRunIds.filter((runId) => satisfiedRunIds.has(runId)).length;
  const unsatisfied = total - satisfied;
  return {
    ready: unsatisfied === 0,
    total,
    satisfied,
    unsatisfied,
  };
}

export function resolveDependencies(
  manifest: Pick<RunManifest, "dependencyRunIds">,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependencyDetail[] {
  return manifest.dependencyRunIds.map((runId) => toRunDependencyDetail(runId, graph.get(runId)));
}

export function resolveDependents(
  manifest: Pick<RunManifest, "runId">,
  graph: ReadonlyMap<string, RunManifest>,
): RunDependencyDetail[] {
  return resolveDependentsFromManifests(
    manifest.runId,
    Array.from(graph.values()).filter(
      (candidate) =>
        candidate.runId !== manifest.runId && candidate.dependencyRunIds.includes(manifest.runId),
    ),
  );
}

export function resolveDependentsFromManifests(
  targetRunId: string,
  manifests: Iterable<RunManifest>,
): RunDependencyDetail[] {
  return Array.from(manifests)
    .filter((candidate) => candidate.runId !== targetRunId)
    .sort((left, right) => {
      const byTime = right.startedAt.localeCompare(left.startedAt);
      return byTime !== 0 ? byTime : left.runId.localeCompare(right.runId);
    })
    .map((candidate) => toRunDependencyDetail(candidate.runId, candidate));
}

export function countUnsatisfiedDependencies(
  manifest: Pick<RunManifest, "dependencyRunIds">,
  graph: ReadonlyMap<string, RunManifest>,
): number {
  return deriveDependencyState(manifest, graph).unsatisfied;
}

export function wouldCreateDependencyCycle(
  graph: ReadonlyMap<string, RunManifest>,
  targetRunId: string,
  dependencyRunId: string,
): boolean {
  const stack = [dependencyRunId];
  const seen = new Set<string>();

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || seen.has(current)) {
      continue;
    }
    if (current === targetRunId) {
      return true;
    }
    seen.add(current);
    const manifest = graph.get(current);
    if (!manifest) {
      continue;
    }
    for (const next of manifest.dependencyRunIds) {
      if (!seen.has(next)) {
        stack.push(next);
      }
    }
  }

  return false;
}
