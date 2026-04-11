# task-runner

A minimal CLI that invokes an AI agent with a pre-seeded task list and
enforces completion via retries.

**Status:** scaffolding only. See [`docs/design.md`](docs/design.md) for the
full design.

## What it does

1. You write an agent definition (`agents/<name>/agent.md`) with YAML
   frontmatter that declares a prompt, some input variables, and a list of
   tasks.
2. You run `task-runner run --agent <name> --var k=v`.
3. The runner seeds a `assignment.md` file in a per-run workspace directory and
   invokes the agent (Claude for now) with a prompt that instructs it to
   work through the list and update the status of each task as it goes.
4. After the agent exits, the runner parses `assignment.md` back. If every task
   is marked `completed`, the runner returns the concatenated agent output
   and exits `0`. If tasks are still incomplete, it re-invokes the agent
   with a nudge message — up to `maxRetries` times. If any task is marked
   `blocked`, the runner stops and surfaces the blocker instead of retrying.

## Why not just use agent-runner?

`agent-runner` is feature-rich: a daemon, web console, multiple backends,
fully customizable hooks, session resumption, event streaming. For the
single use case of "give an agent a checklist and make sure it finishes",
most of that is overhead.

`task-runner` bakes the one hook we care about (task-completion enforcement)
directly into the run loop and drops everything else. See
[`docs/design.md`](docs/design.md#non-goals) for the list of explicit
non-goals.

## Prerequisites

- Node.js 20+
- `claude` CLI on your `PATH` (or set `TASK_RUNNER_CLAUDE_BIN`)

## Quickstart

```bash
npm install
npm run build
npm run task-runner -- run --agent example --var repo_path=/path/to/repo
```

## Development

```bash
npm run lint       # biome check
npm run format     # biome format
npm run build      # tsc -b
npm run test       # node --test
```

Pre-commit runs `lint-staged` + `biome check` via husky.

## Layout

- `src/` — TypeScript sources
- `agents/example/agent.md` — reference agent definition
- `docs/design.md` — complete design document
- `test/` — node:test suites
