import {
  type ListedRunManifest,
  type RunManifest,
  listRunManifests,
  resolveResumeTarget,
} from "./manifest.js";

export type RunLineageScope = "run" | "family";

export interface ResolveRunScopeOptions {
  target: string;
  scope: RunLineageScope;
}

export class RunLineageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunLineageError";
  }
}

function compareListedRunEntries(left: ListedRunManifest, right: ListedRunManifest): number {
  const startedAtCompare = left.manifest.startedAt.localeCompare(right.manifest.startedAt);
  if (startedAtCompare !== 0) {
    return startedAtCompare;
  }
  return left.manifest.runId.localeCompare(right.manifest.runId);
}

function buildEntriesByRunId(entries: ListedRunManifest[]): Map<string, ListedRunManifest[]> {
  const entriesByRunId = new Map<string, ListedRunManifest[]>();
  for (const entry of entries) {
    const current = entriesByRunId.get(entry.manifest.runId);
    if (current) {
      current.push(entry);
      current.sort(compareListedRunEntries);
    } else {
      entriesByRunId.set(entry.manifest.runId, [entry]);
    }
  }
  return entriesByRunId;
}

function resolveUniqueLineageEntry(
  runId: string,
  entriesByRunId: Map<string, ListedRunManifest[]>,
): ListedRunManifest {
  const matches = entriesByRunId.get(runId) ?? [];
  if (matches.length === 0) {
    throw new RunLineageError(`family scope could not resolve parent run "${runId}"`);
  }
  if (matches.length > 1) {
    throw new RunLineageError(
      `family scope is ambiguous because parent run "${runId}" exists in multiple run buckets`,
    );
  }
  const match = matches[0];
  if (match === undefined) {
    throw new RunLineageError(`family scope could not resolve parent run "${runId}"`);
  }
  return match;
}

function collectLineageChainFromEntry(
  start: ListedRunManifest,
  entriesByRunId: Map<string, ListedRunManifest[]>,
): ListedRunManifest[] {
  const chain = [start];
  const seenWorkspaceDirs = new Set([start.workspaceDir]);
  let current = start;
  while (current.manifest.parentRunId !== null) {
    const parent = resolveUniqueLineageEntry(current.manifest.parentRunId, entriesByRunId);
    if (seenWorkspaceDirs.has(parent.workspaceDir)) {
      throw new RunLineageError(
        `family scope detected a lineage cycle at parent run "${parent.manifest.runId}"`,
      );
    }
    seenWorkspaceDirs.add(parent.workspaceDir);
    chain.push(parent);
    current = parent;
  }
  return chain;
}

function listScopedRunEntries(
  targetManifest: RunManifest,
  listedEntries: ListedRunManifest[],
): ListedRunManifest[] {
  const entriesByRunId = buildEntriesByRunId(listedEntries);
  const targetEntry = listedEntries.find(
    (entry) => entry.workspaceDir === targetManifest.workspaceDir,
  ) ?? {
    workspaceDir: targetManifest.workspaceDir,
    manifest: targetManifest,
  };
  const targetLineage = collectLineageChainFromEntry(targetEntry, entriesByRunId);
  const targetRootWorkspaceDir = targetLineage.at(-1)?.workspaceDir ?? targetManifest.workspaceDir;
  const targetLineageWorkspaceDirs = new Set(targetLineage.map((entry) => entry.workspaceDir));

  const familyEntries = listedEntries.filter((entry) => {
    try {
      const lineage = collectLineageChainFromEntry(entry, entriesByRunId);
      return lineage.at(-1)?.workspaceDir === targetRootWorkspaceDir;
    } catch {
      return false;
    }
  });
  const remainingFamilyEntries = familyEntries
    .filter((entry) => !targetLineageWorkspaceDirs.has(entry.workspaceDir))
    .sort(compareListedRunEntries);
  return [...targetLineage, ...remainingFamilyEntries];
}

export function resolveScopedRunManifests(options: ResolveRunScopeOptions): RunManifest[] {
  const resolved = resolveResumeTarget(options.target);
  if (options.scope === "run") {
    return [resolved.manifest];
  }

  const listedEntries = listRunManifests();
  const orderedEntries = listScopedRunEntries(resolved.manifest, listedEntries);
  return orderedEntries.map((entry) => {
    if (entry.workspaceDir === resolved.workspaceDir) {
      return resolved.manifest;
    }
    return resolveResumeTarget(entry.workspaceDir).manifest;
  });
}

export function deriveFamilyRootRunIds(
  listedEntries: ListedRunManifest[],
): ReadonlyMap<string, string | null> {
  const entriesByRunId = buildEntriesByRunId(listedEntries);
  const groupedWorkspaceDirs = new Map<string, Set<string>>();
  const rootInfoByWorkspaceDir = new Map<
    string,
    {
      rootRunId: string;
      rootWorkspaceDir: string;
    } | null
  >();

  for (const entry of listedEntries) {
    try {
      const lineage = collectLineageChainFromEntry(entry, entriesByRunId);
      const root = lineage.at(-1);
      if (root === undefined) {
        rootInfoByWorkspaceDir.set(entry.workspaceDir, null);
        continue;
      }
      rootInfoByWorkspaceDir.set(entry.workspaceDir, {
        rootRunId: root.manifest.runId,
        rootWorkspaceDir: root.workspaceDir,
      });
      const group = groupedWorkspaceDirs.get(root.workspaceDir) ?? new Set<string>();
      group.add(entry.workspaceDir);
      groupedWorkspaceDirs.set(root.workspaceDir, group);
    } catch {
      rootInfoByWorkspaceDir.set(entry.workspaceDir, null);
    }
  }

  const familyRootRunIdByWorkspaceDir = new Map<string, string | null>();
  for (const entry of listedEntries) {
    const rootInfo = rootInfoByWorkspaceDir.get(entry.workspaceDir);
    if (!rootInfo) {
      familyRootRunIdByWorkspaceDir.set(entry.workspaceDir, null);
      continue;
    }
    const familySize = groupedWorkspaceDirs.get(rootInfo.rootWorkspaceDir)?.size ?? 0;
    familyRootRunIdByWorkspaceDir.set(
      entry.workspaceDir,
      familySize > 1 ? rootInfo.rootRunId : null,
    );
  }
  return familyRootRunIdByWorkspaceDir;
}
