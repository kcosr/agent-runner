const PATTERN = /\{\{\s*([a-zA-Z0-9_.-]+)\s*\}\}/g;

export function interpolate(input: string, vars: Record<string, unknown>): string {
  return input.replace(PATTERN, (full, key) => {
    const value = vars[key];
    if (value === undefined || value === null) return full;
    return String(value);
  });
}
