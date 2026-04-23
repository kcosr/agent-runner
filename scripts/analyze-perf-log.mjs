#!/usr/bin/env node

import { readFile } from "node:fs/promises";

const PERF_PREFIX = "[task-runner perf] ";
const DEFAULT_TOP = 10;
const METRICS = ["durationMs", "queuedMs", "waitMs", "holdMs", "maxMs", "p99Ms", "meanMs"];

function parseArgs(argv) {
  const args = [...argv];
  let top = DEFAULT_TOP;
  let filePath;
  while (args.length > 0) {
    const arg = args.shift();
    if (!arg) {
      continue;
    }
    if (arg === "--top") {
      const raw = args.shift();
      const parsed = Number.parseInt(raw ?? "", 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid --top value: ${raw ?? "<missing>"}`);
      }
      top = parsed;
      continue;
    }
    if (arg.startsWith("--top=")) {
      const parsed = Number.parseInt(arg.slice("--top=".length), 10);
      if (!Number.isFinite(parsed) || parsed <= 0) {
        throw new Error(`invalid --top value: ${arg.slice("--top=".length)}`);
      }
      top = parsed;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
    if (arg.startsWith("-")) {
      throw new Error(`unknown option: ${arg}`);
    }
    if (filePath) {
      throw new Error(`unexpected extra argument: ${arg}`);
    }
    filePath = arg;
  }
  if (!filePath) {
    throw new Error("missing perf log path");
  }
  return { filePath, top };
}

function printUsage() {
  process.stdout.write(
    [
      "Usage: node scripts/analyze-perf-log.mjs [--top N] <perf-log-path>",
      "",
      "Parses [task-runner perf] lines and prints the highest-latency samples",
      "plus per-event metric summaries.",
      "",
    ].join("\n"),
  );
}

function parseValue(rawValue) {
  if (rawValue.startsWith('"')) {
    return JSON.parse(rawValue);
  }
  if (rawValue === "true") {
    return true;
  }
  if (rawValue === "false") {
    return false;
  }
  const numeric = Number(rawValue);
  if (Number.isFinite(numeric)) {
    return numeric;
  }
  return rawValue;
}

function parseFields(rawFields) {
  const fields = {};
  const matcher = /([A-Za-z][A-Za-z0-9]*)=("(?:\\.|[^"])*"|\S+)/g;
  for (const match of rawFields.matchAll(matcher)) {
    const [, key, rawValue] = match;
    if (!key || !rawValue) {
      continue;
    }
    fields[key] = parseValue(rawValue);
  }
  return fields;
}

function parseLine(line, lineNumber) {
  if (!line.startsWith(PERF_PREFIX)) {
    return null;
  }
  const rest = line.slice(PERF_PREFIX.length);
  const firstSpace = rest.indexOf(" ");
  if (firstSpace === -1) {
    return null;
  }
  const timestamp = rest.slice(0, firstSpace);
  const afterTimestamp = rest.slice(firstSpace + 1);
  const secondSpace = afterTimestamp.indexOf(" ");
  const event = secondSpace === -1 ? afterTimestamp : afterTimestamp.slice(0, secondSpace);
  const rawFields = secondSpace === -1 ? "" : afterTimestamp.slice(secondSpace + 1);
  return {
    lineNumber,
    raw: line,
    timestamp,
    event,
    fields: parseFields(rawFields),
  };
}

function summarizeMetric(samples, metricName) {
  const metricSamples = samples.filter((sample) => typeof sample.fields[metricName] === "number");
  if (metricSamples.length === 0) {
    return null;
  }
  const values = metricSamples
    .map((sample) => Number(sample.fields[metricName]))
    .sort((left, right) => right - left);
  const total = values.reduce((sum, value) => sum + value, 0);
  return {
    count: values.length,
    average: total / values.length,
    max: values[0] ?? 0,
  };
}

function formatNumber(value) {
  return value.toFixed(3);
}

function formatSample(sample, metricName) {
  const value = sample.fields[metricName];
  const tailFields = Object.entries(sample.fields)
    .filter(([key]) => key !== metricName)
    .map(([key, fieldValue]) => `${key}=${JSON.stringify(fieldValue)}`)
    .join(" ");
  const suffix = tailFields ? ` ${tailFields}` : "";
  return `${formatNumber(Number(value))} ${sample.event}${suffix} line=${sample.lineNumber}`;
}

function printTopSamples(samples, metricName, top) {
  const ranked = samples
    .filter((sample) => typeof sample.fields[metricName] === "number")
    .sort((left, right) => Number(right.fields[metricName]) - Number(left.fields[metricName]))
    .slice(0, top);
  if (ranked.length === 0) {
    return;
  }
  process.stdout.write(`\nTop ${metricName} samples\n`);
  for (const sample of ranked) {
    process.stdout.write(`- ${formatSample(sample, metricName)}\n`);
  }
}

function printEventSummaries(samples, metricName, top) {
  const summaries = new Map();
  for (const sample of samples) {
    const value = sample.fields[metricName];
    if (typeof value !== "number") {
      continue;
    }
    const current = summaries.get(sample.event) ?? { count: 0, total: 0, max: 0 };
    current.count += 1;
    current.total += value;
    current.max = Math.max(current.max, value);
    summaries.set(sample.event, current);
  }
  const ranked = [...summaries.entries()]
    .map(([event, summary]) => ({
      event,
      count: summary.count,
      average: summary.total / summary.count,
      max: summary.max,
    }))
    .sort((left, right) => right.max - left.max)
    .slice(0, top);
  if (ranked.length === 0) {
    return;
  }
  process.stdout.write(`\nTop ${metricName} events\n`);
  for (const summary of ranked) {
    process.stdout.write(
      `- ${summary.event} count=${summary.count} avg=${formatNumber(summary.average)} max=${formatNumber(summary.max)}\n`,
    );
  }
}

async function main() {
  const { filePath, top } = parseArgs(process.argv.slice(2));
  const text = await readFile(filePath, "utf8");
  const samples = text
    .split(/\r?\n/)
    .map((line, index) => parseLine(line, index + 1))
    .filter((sample) => sample !== null);

  process.stdout.write(`Parsed ${samples.length} perf lines from ${filePath}\n`);

  for (const metricName of METRICS) {
    const summary = summarizeMetric(samples, metricName);
    if (!summary) {
      continue;
    }
    process.stdout.write(
      `Metric ${metricName}: count=${summary.count} avg=${formatNumber(summary.average)} max=${formatNumber(summary.max)}\n`,
    );
    printTopSamples(samples, metricName, top);
    printEventSummaries(samples, metricName, top);
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
