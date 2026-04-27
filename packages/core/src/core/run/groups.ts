import type { ListedRunManifest, RunManifest } from "./manifest.js";

const MAX_RUN_GROUP_ID_LENGTH = 128;

function containsInvalidRunGroupIdCharacter(value: string): boolean {
  return Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint < 0x20 || codePoint === 0x7f || character === "/" || character === "\\";
  });
}

export class RunGroupValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunGroupValidationError";
  }
}

export function isValidRunGroupId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= MAX_RUN_GROUP_ID_LENGTH &&
    value === value.trim() &&
    !containsInvalidRunGroupIdCharacter(value)
  );
}

export function validateRunGroupId(input: string, label = "run group id"): string {
  const value = input.trim();
  if (value.length === 0) {
    throw new RunGroupValidationError(`${label} cannot be empty`);
  }
  if (value.length > MAX_RUN_GROUP_ID_LENGTH) {
    throw new RunGroupValidationError(
      `${label} must be ${MAX_RUN_GROUP_ID_LENGTH} characters or fewer`,
    );
  }
  if (containsInvalidRunGroupIdCharacter(value)) {
    throw new RunGroupValidationError(`${label} cannot contain control characters, /, or \\`);
  }
  return value;
}

export function listRunGroupMembers(
  entries: Iterable<ListedRunManifest>,
  runGroupId: string,
  options: { includeArchived: boolean },
): ListedRunManifest[] {
  return Array.from(entries).filter(
    (entry) =>
      entry.manifest.runGroupId === runGroupId &&
      (options.includeArchived || entry.manifest.archivedAt === null),
  );
}

export function listRunGroupMemberManifests(
  manifests: Iterable<RunManifest>,
  runGroupId: string,
  options: { includeArchived: boolean },
): RunManifest[] {
  return Array.from(manifests).filter(
    (manifest) =>
      manifest.runGroupId === runGroupId &&
      (options.includeArchived || manifest.archivedAt === null),
  );
}
