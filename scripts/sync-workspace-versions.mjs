#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const PACKAGE_PATHS = [
  "package.json",
  "packages/core/package.json",
  "apps/cli/package.json",
  "apps/web/package.json",
];

const CORE_PACKAGE_NAME = "@kcosr/agent-runner-core";

function usage() {
  return [
    "Usage: node scripts/sync-workspace-versions.mjs [--version <version>] [--check]",
    "",
    "Synchronizes workspace package versions and internal core dependency refs.",
    "When --version is omitted, the root package.json version is used.",
  ].join("\n");
}

function parseArgs(argv) {
  const args = { check: false, version: null };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--check") {
      args.check = true;
    } else if (arg === "--version") {
      const version = argv[index + 1];
      if (!version || version.startsWith("--")) {
        throw new Error("--version requires a value");
      }
      args.version = version;
      index += 1;
    } else if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    } else {
      throw new Error(`Unknown option: ${arg}`);
    }
  }

  return args;
}

function assertVersion(version) {
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error(`Invalid semver version: ${version}`);
  }
}

async function readJson(relativePath) {
  const path = resolve(repoRoot, relativePath);
  return {
    data: JSON.parse(await readFile(path, "utf8")),
    path,
    relativePath,
  };
}

function setDependencyVersion(pkg, dependencyName, version) {
  for (const section of [
    "dependencies",
    "devDependencies",
    "peerDependencies",
    "optionalDependencies",
  ]) {
    if (pkg[section]?.[dependencyName]) {
      pkg[section][dependencyName] = version;
    }
  }
}

function serializeJson(data) {
  return `${JSON.stringify(data, null, 2)}\n`;
}

const args = parseArgs(process.argv.slice(2));
const packages = await Promise.all(PACKAGE_PATHS.map(readJson));
const rootPackage = packages.find((pkg) => pkg.relativePath === "package.json");
const targetVersion = args.version ?? rootPackage.data.version;

assertVersion(targetVersion);

const changed = [];

for (const pkg of packages) {
  if (pkg.data.version !== targetVersion) {
    changed.push(`${pkg.relativePath}: version ${pkg.data.version} -> ${targetVersion}`);
    pkg.data.version = targetVersion;
  }

  const before = JSON.stringify(pkg.data);
  setDependencyVersion(pkg.data, CORE_PACKAGE_NAME, targetVersion);
  const after = JSON.stringify(pkg.data);
  if (before !== after) {
    changed.push(`${pkg.relativePath}: ${CORE_PACKAGE_NAME} dependency -> ${targetVersion}`);
  }
}

if (args.check) {
  if (changed.length > 0) {
    process.stderr.write(`Workspace versions are not synchronized:\n${changed.join("\n")}\n`);
    process.exit(1);
  }
  process.stdout.write(`Workspace versions are synchronized at ${targetVersion}\n`);
  process.exit(0);
}

if (changed.length === 0) {
  process.stdout.write(`Workspace versions already synchronized at ${targetVersion}\n`);
} else {
  for (const pkg of packages) {
    await writeFile(pkg.path, serializeJson(pkg.data));
  }
  process.stdout.write(
    `Synchronized workspace versions at ${targetVersion}:\n${changed.join("\n")}\n`,
  );
}
