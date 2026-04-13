export function trimRunName(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new Error("run name cannot be empty");
  }
  return trimmed;
}

export function normalizeOptionalRunName(value: string | undefined): string | null {
  if (value === undefined) {
    return null;
  }
  return trimRunName(value);
}

export function normalizeRunNameMutation(input: {
  name?: string;
  clear?: boolean;
}): string | null {
  if (input.clear === true) {
    return null;
  }
  if (input.name === undefined) {
    throw new Error("run name is required unless clear is set");
  }
  return trimRunName(input.name);
}
