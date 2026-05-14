#!/usr/bin/env node

import {
  existsSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

const REPLACEMENTS = [
  ["TASK_RUNNER", "AGENT_RUNNER"],
  ["task_runner_cmd", "agent_runner_cmd"],
  ["task_runner", "agent_runner"],
  ["TaskRunner", "AgentRunner"],
  ["Task Runner", "Agent Runner"],
  ["taskRunner", "agentRunner"],
  ["@task-runner", "@agent-runner"],
  ["x-task-runner", "x-agent-runner"],
  ["task-runner", "agent-runner"],
];

function usage() {
  return [
    "Usage: node scripts/migrate-task-runner-to-agent-runner.mjs [options]",
    "",
    "Dry-run by default. Use --write to rename paths and rewrite files.",
    "Migrates local TaskRunner state/config data to Agent Runner naming.",
    "",
    "Options:",
    "  --home <path>                 Base home directory for default paths",
    "  --state-root <path>           Legacy state root (default: <home>/.local/state/task-runner)",
    "  --target-state-root <path>    Agent Runner state root (default: <home>/.local/state/agent-runner)",
    "  --config-root <path>          Legacy config root (default: <home>/.config/task-runner)",
    "  --target-config-root <path>   Agent Runner config root (default: <home>/.config/agent-runner)",
    "  --bashrc <path>               Shell rc file to rewrite (default: <home>/.bashrc)",
    "  --skip-bashrc                 Do not inspect or rewrite the shell rc file",
    "  --write                       Apply changes; omitted means dry-run",
    "  -h, --help                    Show this help",
  ].join("\n");
}

function readRequiredValue(argv, index, flag) {
  const value = argv[index + 1];
  if (!value || value.startsWith("--")) throw new Error(`${flag} requires a path`);
  return value;
}

function parseArgs(argv) {
  const parsed = {
    home: homedir(),
    stateRoot: null,
    targetStateRoot: null,
    configRoot: null,
    targetConfigRoot: null,
    bashrc: null,
    skipBashrc: false,
    write: false,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--write") {
      parsed.write = true;
      continue;
    }
    if (arg === "--skip-bashrc") {
      parsed.skipBashrc = true;
      continue;
    }
    if (arg === "--home") {
      parsed.home = resolve(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--state-root") {
      parsed.stateRoot = resolve(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--target-state-root") {
      parsed.targetStateRoot = resolve(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--config-root") {
      parsed.configRoot = resolve(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--target-config-root") {
      parsed.targetConfigRoot = resolve(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--bashrc") {
      parsed.bashrc = resolve(readRequiredValue(argv, index, arg));
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`unknown argument: ${arg}`);
  }

  parsed.stateRoot ??= join(parsed.home, ".local/state/task-runner");
  parsed.targetStateRoot ??= join(parsed.home, ".local/state/agent-runner");
  parsed.configRoot ??= join(parsed.home, ".config/task-runner");
  parsed.targetConfigRoot ??= join(parsed.home, ".config/agent-runner");
  parsed.bashrc ??= join(parsed.home, ".bashrc");
  return parsed;
}

function replaceLegacyNames(value) {
  let next = value;
  for (const [from, to] of REPLACEMENTS) {
    next = next.split(from).join(to);
  }
  return next;
}

function isTextBuffer(buffer) {
  return !buffer.includes(0);
}

function collectEntries(root) {
  const entries = [];
  function visit(path) {
    const stat = statSync(path);
    entries.push({ path, stat });
    if (!stat.isDirectory()) return;
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      visit(join(path, entry.name));
    }
  }
  visit(root);
  return entries;
}

function preflightRenameConflicts(root) {
  const conflicts = [];
  for (const { path } of collectEntries(root)) {
    const target = join(dirname(path), replaceLegacyNames(basename(path)));
    if (target !== path && existsSync(target)) {
      conflicts.push(`${path} -> ${target} already exists`);
    }
  }
  return conflicts;
}

function rewriteFile(path, write, counters) {
  const buffer = readFileSync(path);
  if (!isTextBuffer(buffer)) {
    counters.skippedBinary += 1;
    return;
  }
  const raw = buffer.toString("utf8");
  const rewritten = replaceLegacyNames(raw);
  if (rewritten === raw) return;
  counters.filesRewritten += 1;
  process.stdout.write(
    `${write ? "WRITE" : "DRY"}  ${path}: ${write ? "rewrote" : "would rewrite"} content\n`,
  );
  if (write) writeFileSync(path, rewritten);
}

function rewriteTree(root, write, counters) {
  function visit(path) {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path, { withFileTypes: true })) {
        visit(join(path, entry.name));
      }
    } else if (stat.isFile()) {
      rewriteFile(path, write, counters);
    }

    if (path === root) return;
    const name = basename(path);
    const rewrittenName = replaceLegacyNames(name);
    if (rewrittenName === name) return;
    const target = join(dirname(path), rewrittenName);
    counters.pathsRenamed += 1;
    process.stdout.write(
      `${write ? "WRITE" : "DRY"}  ${path}: ${write ? "renamed" : "would rename"} to ${target}\n`,
    );
    if (write) renameSync(path, target);
  }

  visit(root);
}

function migrateRoot({ label, source, target }, options, counters, conflicts) {
  if (source === target) {
    conflicts.push(`${label}: source and target roots are the same path (${source})`);
    return;
  }

  const sourceExists = existsSync(source);
  const targetExists = existsSync(target);
  if (sourceExists && targetExists) {
    conflicts.push(`${label}: ${source} and ${target} both exist`);
    return;
  }
  if (!sourceExists && !targetExists) {
    process.stdout.write(`SKIP  ${label}: neither ${source} nor ${target} exists\n`);
    return;
  }

  const scanRoot = sourceExists ? source : target;
  conflicts.push(...preflightRenameConflicts(scanRoot).map((conflict) => `${label}: ${conflict}`));
  if (conflicts.length > 0) return;

  if (sourceExists) {
    counters.rootsMoved += 1;
    process.stdout.write(
      `${options.write ? "WRITE" : "DRY"}  ${label}: ${options.write ? "moved" : "would move"} ${source} -> ${target}\n`,
    );
    if (options.write) renameSync(source, target);
  }

  rewriteTree(sourceExists && options.write ? target : scanRoot, options.write, counters);
}

function migrateBashrc(path, options, counters) {
  if (options.skipBashrc) {
    process.stdout.write("SKIP  bashrc: disabled by --skip-bashrc\n");
    return;
  }
  if (!existsSync(path)) {
    process.stdout.write(`SKIP  bashrc: ${path} does not exist\n`);
    return;
  }
  const raw = readFileSync(path, "utf8");
  const rewritten = replaceLegacyNames(raw);
  if (rewritten === raw) {
    process.stdout.write(`OK    bashrc: ${path} has no TaskRunner names\n`);
    return;
  }
  counters.filesRewritten += 1;
  process.stdout.write(
    `${options.write ? "WRITE" : "DRY"}  bashrc: ${options.write ? "rewrote" : "would rewrite"} ${path}\n`,
  );
  if (options.write) writeFileSync(path, rewritten);
}

function run(argv) {
  const options = parseArgs(argv);
  const counters = { rootsMoved: 0, pathsRenamed: 0, filesRewritten: 0, skippedBinary: 0 };
  const conflicts = [];

  migrateRoot(
    { label: "state", source: options.stateRoot, target: options.targetStateRoot },
    options,
    counters,
    conflicts,
  );
  migrateRoot(
    { label: "config", source: options.configRoot, target: options.targetConfigRoot },
    options,
    counters,
    conflicts,
  );

  if (conflicts.length > 0) {
    for (const conflict of conflicts) {
      process.stderr.write(`CONFLICT ${conflict}\n`);
    }
    process.stderr.write("Migration aborted before writing changes.\n");
    process.exitCode = 1;
    return;
  }

  migrateBashrc(options.bashrc, options, counters);
  process.stdout.write(
    `SUMMARY mode=${options.write ? "write" : "dry-run"} rootsMoved=${counters.rootsMoved} pathsRenamed=${counters.pathsRenamed} filesRewritten=${counters.filesRewritten} skippedBinary=${counters.skippedBinary}\n`,
  );
}

try {
  run(process.argv.slice(2));
} catch (error) {
  process.stderr.write(`${error.message}\n\n${usage()}\n`);
  process.exitCode = 2;
}
