import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
  interopDefault: true,
});

export async function importModule(path: string): Promise<unknown> {
  return jiti.import(path);
}

export async function importDefaultOrModule<T>(path: string): Promise<T> {
  const imported = await importModule(path);
  if (imported && typeof imported === "object" && "default" in imported && imported.default) {
    return imported.default as T;
  }
  return imported as T;
}
