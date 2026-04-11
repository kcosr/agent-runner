---
schemaVersion: 1
name: code-review
sessionName: code review {{range}} · {{repo_path}}
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository to review.
  range:
    type: string
    required: false
    source: cli
    default: full
    description: |
      What scope to review. One of:
        - `full`                        — entire codebase (default)
        - `unstaged`                    — `git diff` (working tree)
        - `staged`                      — `git diff --cached`
        - `last commit`                 — `git show HEAD`
        - `HEAD~N..HEAD`                — N commits back to HEAD
        - `main..<branch>`              — branch divergence
        - any other git range spec      — passed through to git
tasks:
  - id: t01_orient
    title: Repo orientation and scope resolution
    body: |
      First, understand the project. Read the high-signal entry
      points for the repository at `{{repo_path}}`:
        - AGENTS.md, CLAUDE.md, CONTRIBUTING.md at the repo root
        - README.md
        - Build manifest (package.json, Cargo.toml, go.mod,
          pyproject.toml, etc.) for scripts, dependencies, and
          language toolchain
        - docs/ directory (design docs, architecture notes)
        - Primary entry-point files (`src/cli.ts`, `main.rs`,
          `main.go`, `src/index.*`, or what the build manifest
          points at)

      Second, resolve the review scope from `range = "{{range}}"`:
        - If `range` is `full`, the scope is the whole codebase.
          Proceed through the following tasks with the whole
          codebase in mind.
        - If `range` is a git-style spec (`unstaged`, `staged`,
          `last commit`, `HEAD~N..HEAD`, `main..branch`, or any
          other phrase), translate it to a concrete git
          invocation and identify the exact set of files and
          hunks that changed. Run the appropriate command:
            - `unstaged`        → `git diff`
            - `staged`          → `git diff --cached`
            - `last commit`     → `git show HEAD`
            - a git range spec  → `git diff <spec>`
          Capture the list of touched files. For the rest of the
          review, *also* read each touched file in full (not just
          the diff) so you can judge the change in context.

      Notes: a 5-10 line summary of what the project is, its
      major modules, and — if scoped — the concrete set of files
      and hunks under review. This is context for the rest of the
      review, not a finding section.
  - id: t02_architecture
    title: Architecture & module boundaries
    body: |
      Review the module layout and component boundaries for
      design smells. If the scope is ranged, focus on whether the
      change introduces or worsens any of these, not on
      pre-existing architecture you can't affect.

      Look for:
        - Modules doing more than one thing
        - Coupling that should be inverted (low-level depending
          on high-level)
        - Abstractions that exist but aren't pulling weight
        - Abstractions that should exist but don't (duplicated
          logic across sibling modules — also see t09)
        - Layer violations (e.g. a backend module reaching into
          runner state, a UI module calling a DB layer directly)
        - Asymmetries between sibling modules that suggest one is
          wrong
        - Circular dependencies

      If the scope is too small for this dimension to produce
      real findings, say so and move on. Format per role
      instructions.
  - id: t03_concurrency
    title: Concurrency & async safety
    body: |
      This is usually the highest-leverage dimension. Look for:
        - Promise/future rejections that are silently swallowed
          (`.catch(() => {})`, bare `try { } catch {}` without
          rethrow/log, Go `_ = err`, Rust `.unwrap()` on a
          genuinely fallible result, etc.)
        - Race conditions: shared mutable state touched from
          multiple async paths without ordering guarantees
        - Listeners (`.on`, `addEventListener`, channels,
          observers) that aren't removed on every completion
          path, especially error/close paths
        - Timers (`setTimeout`, `setInterval`, select timeouts)
          that aren't cleared on every exit
        - AbortSignal / cancellation handling: pre-cancelled
          signals, listeners that fire after the awaited
          operation already settled
        - Child processes, file handles, and sockets that aren't
          cleaned up on failure paths
        - `Promise.race` / `select` patterns where the losing
          branch keeps running and may still cause side effects
        - `async`/`await` mistakes: forgotten `await`, awaiting
          in a loop when parallel would be correct, awaiting
          outside a `try` so errors bypass handlers

      Read every backend adapter, every subprocess wrapper, and
      the main loop(s) for the code. Format per role instructions.
  - id: t04_error_handling
    title: Error handling & edge cases
    body: |
      For each user-visible operation in scope, ask: what happens
      when it fails? Specifically walk through:
        - Malformed config files (truncated, wrong type, extra
          fields, schema-version mismatch)
        - Missing files or directories
        - Permission errors on read or write
        - Network failures mid-request (for any network-touching
          code)
        - Subprocess crashes vs subprocess non-zero exit vs
          subprocess hang
        - Empty input where the code assumes non-empty
        - Concurrent processes writing to the same file
        - Disk full / EIO mid-write

      Are errors actionable to a user (with file:line, suggested
      fix)? Are partial states left on disk if a write fails
      halfway? Look especially at any code that writes to disk
      and any code that parses external input.
  - id: t05_state_machine
    title: State machine & lifecycle correctness
    body: |
      Identify the explicit and implicit state machines in the
      code. Examples: persisted status enums, session lifecycles,
      build-phase transitions, resource acquire/release cycles.

      For each, ask:
        - Are all states reachable? Are any unreachable?
        - Are illegal transitions guarded against, or just
          unreachable by accident? (Defense in depth: can a
          corrupted input trigger an illegal start state?)
        - On failure mid-transition, does the persisted state
          make sense, or is it stuck between two consistent
          states?
        - Are status fields ever stale relative to the truth
          (e.g. `running` after the process died)?
  - id: t06_resources
    title: Resource management & cleanup
    body: |
      Any code that allocates a non-memory resource is suspect.
      Look for:
        - File handles (open()/createReadStream/etc.)
        - Child processes (spawn/fork/exec)
        - Sockets, WebSockets, DB connections
        - Directories or temp files created but never cleaned up
        - Anything in `os.tmpdir()` or equivalent

      For each, is there a guaranteed release path on success
      AND every failure mode? Trace the close() chain by reading
      code, not by trusting "the process will exit eventually" —
      long-lived runs cannot rely on process exit.

      Also flag anything that grows unboundedly (arrays, maps,
      log buffers, caches) without a cap.
  - id: t07_security
    title: Security & untrusted-input handling
    body: |
      Identify the trust boundaries — where untrusted input
      crosses into the code. Typical sources: CLI args, env
      variables, files written by another process or an AI
      agent, HTTP/RPC request bodies, user-supplied regex or
      queries, config files from a shared directory.

      For each input, trace where it lands:
        - Does it become part of a shell command? (command
          injection — `exec` vs `spawn(args-array)`)
        - Does it become a file path? (path traversal, `..`
          segments, symlink following)
        - Does it become part of a prompt sent to an AI? (prompt
          injection — limit by design, not promise)
        - Are secrets (API keys, env vars marked sensitive) ever
          logged, persisted to disk, or included in error
          messages?
        - Is there any `eval`, `Function`, dynamic `require`,
          or user-supplied regex with potential ReDoS?
  - id: t08_types_schema
    title: Type safety & schema rigor
    body: |
      Is the type system load-bearing or decorative?
        - `any`, `as unknown as T`, `@ts-ignore`,
          `@ts-expect-error`, Rust `unsafe`, Go
          `interface{}`/`reflect` — where, and is each
          justified?
        - Untyped `JSON.parse` results (or equivalents in other
          languages) that flow into typed code without a runtime
          check (zod, serde, pydantic, type guards)
        - Discriminated unions with implicit fall-through cases
        - Schemas where the library's default behavior silently
          drops fields the author probably wanted to validate
        - Schema versioning: how does the code handle a v2
          payload when only v1 is understood? Loud failure or
          silent misinterpret?
        - Optional fields where code assumes presence
  - id: t09_simplification_and_duplication
    title: Simplification & duplication
    body: |
      Two related dimensions that often pay for themselves
      immediately:

      **Simplification.** Look for code that's more complex than
      the problem it solves:
        - Functions doing multiple unrelated things
        - Class hierarchies where a tagged union or plain
          function would do
        - Conditional chains longer than three branches that
          could be a lookup table, map, or polymorphic dispatch
        - 20-40 line blocks that express what 5-10 well-named
          helper calls would
        - "Clever" patterns (bitwise flags, stringly-typed
          registries, reflection gymnastics) where the intent
          isn't obvious from the code
        - Layered indirection where the layers don't add
          anything (e.g. wrapper classes that just forward
          every method)
        - Pre-optimizations: caches, pools, or batching for
          operations that aren't actually hot

      For each, quote the current shape (a few lines) and
      sketch the simpler shape in the suggested fix.

      **Duplication.** Look for repeated logic whose invariants
      must stay in sync:
        - The same computation inlined in multiple call sites
        - Parallel code paths that differ only in one parameter
        - Copy-pasted error handling blocks
        - Validation logic duplicated between the schema and
          the runtime check
        - Cross-language duplication (e.g. a type defined in
          both a TS file and a Rust file that will silently
          diverge)

      For each, cite every instance. Propose the extraction
      point — the shared helper, the shared type, the shared
      module — and note which invariant the consolidation
      protects.

      Be specific: "this is duplicated" is not a finding.
      "`src/a.ts:12-28` and `src/b.ts:40-56` both implement
      retry with exponential backoff; if the backoff constant
      changes in one, the other silently diverges" is.
  - id: t10_test_coverage
    title: Test coverage gaps
    body: |
      Skim the test directory. For each fragile area you flagged
      in earlier tasks, check whether a test exercises it.
      Specifically:
        - Code paths in async error handlers that have no test
        - Edge cases (empty, max, boundary) that have no test
        - Modules where only the happy path is tested
        - Lifecycle interactions (retries, resume, abort, init,
          cleanup) that aren't combinatorially covered
        - Tests that exercise the type but not the value (e.g.
          "calls succeed" without checking what they returned)

      If the project has a test command, run it once and report
      whether everything currently passes. If the scope is
      ranged, check whether the change added tests for its own
      new code paths.
  - id: t11_docs_drift
    title: Documentation accuracy
    body: |
      Compare the code in scope against the documentation that
      describes it. Specifically:
        - Field names and types in interface blocks
        - CLI flag lists and behavior
        - File path examples
        - Status enum values
        - Behavior claims ("the runner does X on resume")

      Drift between docs and code is a finding. Stale claims are
      a higher-severity finding than missing docs because they
      actively mislead.

      (This is a code review, not a doc review — keep it to
      inaccuracies and contradictions. For a full doc pass use
      the `doc-review` assignment.)
  - id: t12_synthesis
    title: Top findings synthesis
    body: |
      Now read back through the notes you wrote on tasks t02-t11
      and build a single ranked list of the **top 10
      highest-leverage findings** from the entire review. Order
      by severity (CRITICAL first, then HIGH, MEDIUM, LOW) and
      within a severity by impact. Each entry must reference the
      original finding's file:line so the reader can jump back.

      If you found fewer than 10 real issues, list the real
      ones and stop. Padding the list with NITs is not a
      synthesis.

      Also include:
        - One sentence on the project's overall health
        - The single highest-leverage refactor (if any) that
          would make several findings disappear at once
        - For ranged reviews: a one-sentence "should this change
          land?" recommendation — ship, ship with changes, or
          block
---
You are reviewing the repository at `{{repo_path}}` with scope
`{{range}}`. Treat `{{repo_path}}` as the root for everything you
read. Do not modify any file inside that repo — the only file you
should write is your workspace plan at `{{assignment_path}}`.

Work the tasks in order. Earlier tasks build context the later
ones depend on — don't skip ahead. The synthesis task at the end
pulls from your accumulated notes, so be specific in each task's
notes block.

A dimension with no real issues produces no findings in that
task. Say "No issues found in this dimension" and move on.
Padding the review to look thorough is worse than a short honest
review.

**Delegating via subagents.** For a large review, you may
delegate independent task dimensions to subagents to
parallelize — e.g. run the concurrency review and the security
review as separate subagents while you prepare the synthesis.
Do not delegate the orient task (t01) or the synthesis task
(t12); both depend on your own accumulated context. When a
subagent returns, fold its findings into the task's Notes
block in the same severity/format used by the rest of the
review so the synthesis pass sees a consistent shape.
Delegation is optional — for a small or ranged review, working
the tasks yourself is usually faster.
