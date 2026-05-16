# Hooks

Hooks are deterministic, user-authored extensions that run at fixed
points in a run's lifecycle. Where the worker is an LLM backend, a hook
is ordinary code with a predictable contract: it can block a run,
rewrite the next prompt, mutate run metadata, stage attachments, or gate
a task transition.

Hooks are declared on assignments and on individual tasks. See
[agents-and-assignments.md](agents-and-assignments.md#assignment-definition)
for where the `hooks:` block sits in the assignment frontmatter schema.

## Phases

Assignments declare hook arrays under five phases:

| Phase | Runs |
|-------|------|
| `prepare` | once, during fresh `run` / `init`, before the first manifest write |
| `beforeAttempt` | before each backend attempt |
| `afterAttempt` | after each backend attempt |
| `afterExit` | after the run loop exits |
| `taskTransition` | transactionally around every task mutation |

Assignment hooks are part of the frozen manifest contract, not an
ephemeral loader detail (see [Prepare hooks and freezing](#prepare-hooks-and-freezing)).

## Declaring hooks

Each hook entry selects exactly one source:

```yaml
hooks:
  prepare:
    - builtin: git-worktree
      with:
        repo: "{{cwd}}"
        from: main
        branch: feature-review
        path: "{{cwd}}/.worktrees/feature-review"
    - name: freeze-prepare
      with:
        mode: strict
    - path: ./hooks/seed-context.mts
```

- `builtin` loads one of the first-party hooks shipped by core (see
  [Built-in hooks](#built-in-hooks)).
- `name` resolves from
  `${AGENT_RUNNER_CONFIG_DIR}/hooks/<name>/hook.(ts|mts|js|mjs)`.
- `path` resolves relative to the authored `assignment.md`.

Raw `.ts` / `.mts` hook files load directly through the runtime's `jiti`
loader, so hook authors do not need a separate build step.

## `when` filters

`when` filters are intentionally narrow:

- Attempt phases (`beforeAttempt`, `afterAttempt`, `afterExit`) support
  `when.sessionIndex` and `when.attemptIndexInSession`, each as one
  integer or an array of integers. Session index `0` is the first
  execution session; attempt-in-session `0` is the first backend attempt
  within that execution session.
- `taskTransition` supports `when.taskId`, `when.taskIds`,
  `when.fromStatus`, `when.toStatus`, and `when.source`.

## Task-local hooks

Tasks can carry their own hooks under `tasks[].hooks[]`. These are always
`taskTransition` hooks scoped to the enclosing task; they use the same
`builtin` / `name` / `path`, `when`, and `with` shape as root
`hooks.taskTransition[]`, and do not use a nested `taskTransition:` key.

Task-local hooks run before root `hooks.taskTransition[]`.

```yaml
tasks:
  - id: peer_review
    title: Peer review
    hooks:
      - builtin: require-children-success
        with:
          requireAny: false
```

## Prepare hooks and freezing

`prepare` hooks run once during fresh `run` / `init`, before the first
manifest write. Their resolved descriptor, config, mutated prompts, vars,
cwd, and hook state are then frozen into the manifest. Resume and reset
reuse that frozen prepare output instead of re-reading the current hook
source.

## Mutation boundaries

What each phase may mutate:

- `prepare` may mutate run config (`cwd`, backend/model/effort,
  timeout/unrestricted, prompts, locked fields), runtime vars, hook
  state, note/pin metadata, task patches, and attachments. Backend args
  are resolved from the final selected backend after prepare changes.
- Non-prepare phases may mutate run config, hook state, note/pin
  metadata, task patches, and attachments — but not runtime vars.
- `taskTransition` hooks run transactionally around `task set`,
  `task append-notes`, `task add`, and the run loop's own task writes.
  If a task-transition hook rejects, the requested task edit rolls back,
  but the hook's own accepted side effects (notes, pins, attachments,
  task patches) still persist.

## Built-in hooks

| Hook | Phases | Behavior |
|------|--------|----------|
| `git-worktree` | `prepare`, `beforeAttempt` | Ensures a git worktree and switches the run `cwd` to it. In `prepare` it also projects `worktree_path` into runtime vars. |
| `command` | every phase | Runs a command. `mode: status` treats exit `0` as success and a non-zero exit as block/reject. `mode: json` requires exit `0` and parses a full hook result from stdout; malformed JSON is a runtime error. |
| `require-children-success` | `taskTransition` | Guards task completion until all direct child runs (by `parentRunId`) are `success`. Scope it with task-local placement or `when.taskId` / `when.taskIds`. Set `requireAny: true` to refuse completion until at least one child run exists. |

## Authoring hook modules

First-party and custom hooks share the public authoring surface exported
from `@kcosr/agent-runner-core/hooks`:

```ts
import { defineHook, type PrepareHookContext } from "@kcosr/agent-runner-core/hooks";

export default defineHook({
  name: "freeze-prepare",
  prepare(ctx: PrepareHookContext) {
    return {
      action: "continue",
      mutate: {
        state: { prepared: true },
        note: `prepared in ${ctx.run.cwd}`,
      },
    };
  },
});
```

Use `defineHook(...)` for type inference. Prepare and attempt-phase hooks
return one of:

- `action: "continue"` — keep going
- `action: "reinvoke"` with `followUpPrompt` — rewrite the next prompt
- `action: "block"` with `reason` — stop the run

Task-transition hooks return `{ accept: true }` or
`{ accept: false, reason }` instead.

A named or path hook module resolves from the locations described in
[Declaring hooks](#declaring-hooks).
