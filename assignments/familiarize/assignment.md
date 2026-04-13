---
schemaVersion: 1
name: familiarize
taskMode: cli
sessionName: familiarize · {{repo_path}}
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository you're going to work in.
tasks:
  - id: read_primary_entry_points
    title: Read the high-signal entry points
    body: |
      Before doing anything else, read the primary orientation
      documents at the repo root:
        - AGENTS.md, CLAUDE.md (if present) — authoritative
          conventions and guardrails the project wants you to
          follow
        - README.md — elevator pitch, features, how the thing is
          used, project layout
        - CONTRIBUTING.md, CODE_OF_CONDUCT.md — if present
        - Build manifest (package.json, Cargo.toml, go.mod,
          pyproject.toml, etc.) — scripts, dependencies,
          toolchain, bin entry points
        - docs/ directory — any design docs, architecture notes,
          or ADRs

      These documents tell you what the project *is*, how it's
      built, and what the author wants you to know before you
      touch anything. Read them in full, not just skim.

      Notes: a short summary (10-20 lines) capturing what the
      project is, who it's for, what the build/test/lint commands
      are, and any non-obvious conventions you noticed.
  - id: run_codemap
    title: Run codemap for a compact code map
    body: |
      Run the following shell command at the repo root:

          codemap --budget 15000

      `codemap` emits a compact, token-budgeted map of the
      codebase's structure and key symbols. Read the full output
      carefully — this is the fastest way to build a mental model
      of the whole project before you start opening individual
      files.

      If `codemap` is not installed (`command not found`), note
      that in your task notes and move on. Do not try to install
      it. Do not substitute `find` or `tree` — those are
      different tools with different output.

      Notes: capture the structural highlights (which modules
      exist, which symbols look load-bearing, what the rough
      call graph feels like). You don't need to paste the full
      codemap output; you need to internalize it.
  - id: inventory_structure
    title: Inventory the directory structure
    body: |
      Walk the top-level directory layout of the repo:
        - Which top-level directories exist?
        - What does each one contain at a glance?
        - Where does source code live vs tests vs docs vs
          tooling vs generated artifacts?
        - Are there multiple languages or toolchains?
        - Are there subpackages / workspaces / crates?

      Cross-reference against what the README and codemap told
      you. If the README claims a layout and reality differs,
      reality wins — note the discrepancy.

      Notes: a short directory tour (15-30 lines). Describe each
      top-level dir in a sentence.
  - id: identify_entry_points
    title: Identify the entry points
    body: |
      Find where the project actually *starts* at runtime.
      Depending on the project type that might be:
        - CLI `main` (bin entry in the build manifest)
        - A library's index / public API surface
        - An HTTP server bootstrap
        - A daemon, a job runner, a background worker
        - Test entry points

      For each entry point you find, note the file path and the
      first-call chain — what does it immediately do, and what
      modules does it hand off to? This is your anchor for
      answering "where would I look if the user asks me to
      change X?".

      Notes: list each entry point with its file path and a
      one-sentence description of what it does.
  - id: map_subsystems
    title: Map the major subsystems and how they talk
    body: |
      Now that you have the directory layout and the entry
      points, sketch the major subsystems and how they
      interact.

      A subsystem is a coherent group of modules with a shared
      responsibility (e.g. "the parser", "the backend adapters",
      "the HTTP layer", "the persistence layer"). For each:
        - Name it
        - List the files/modules it covers
        - Describe what it's responsible for in one sentence
        - Note which other subsystems it depends on

      Notes: a subsystem list with dependencies. Aim for 5-12
      subsystems for a typical project.
  - id: capture_conventions
    title: Project conventions — style, testing, tooling
    body: |
      Capture the operational conventions the project follows,
      sourced from AGENTS.md/CLAUDE.md/CONTRIBUTING.md if they
      exist plus your reading of the build manifest and the
      source. Specifically:
        - What commands does the project use for build, test,
          lint, format? (Quote the exact commands.)
        - What's the test framework and how are tests
          organized?
        - What's the lint/format toolchain? Are there rules
          beyond the defaults?
        - What's the git workflow? (Trunk-based? PRs squash-
          merge? Feature branches?)
        - What's the commit-message style?
        - Are there pre-commit hooks? What do they enforce?
        - Any domain conventions beyond the standard ones
          (error-handling patterns, naming conventions, test
          naming conventions)?

      Notes: a concise conventions reference. This is the
      thing you'll need when you eventually modify code so you
      don't fight the project's style.
  - id: list_unknowns
    title: Unknowns — what you'd have to dig into later
    body: |
      Now flip the frame: given what you've read, what are the
      parts of this codebase you *don't* yet understand, and
      what categories of user request would require digging
      into them?

      For example, for a typical web service:
        - "The auth layer uses JWT but I haven't traced the
          verification path — if the user asks about token
          validation I'd need to start at
          `src/auth/verify.ts`."
        - "I skimmed the DB migrations but didn't read their
          actual SQL — if the user asks about schema
          questions I'd start there."
        - "The retry logic lives in `src/util/retry.ts` but I
          didn't trace it — if the user asks about back-off
          behavior I'd read that file."

      Listing your unknowns explicitly is not a weakness — it's
      how you avoid confidently answering a future question
      incorrectly. Aim for 5-10 honest unknowns. An assignment
      that claims zero unknowns is suspicious.
  - id: self_check_summary
    title: Self-check summary
    body: |
      Before declaring this task complete, run a quick self-
      check. In your own words, answer:
        1. What does this project do, in one sentence?
        2. Who is it for?
        3. What are the three or four most important files if
           someone asked me to make a non-trivial change here
           tomorrow?
        4. What are the build / test / lint commands?
        5. If the user came back now with a follow-up task,
           what's the ONE file I'd open first to orient myself
           in the conversation?

      If you can't answer any of these cleanly, go back and
      fill in the gaps before marking this task complete. The
      whole point of this assignment is that follow-up tasks
      in the same session can rely on you having loaded this
      context properly.

      Notes: the five answers above, each in 1-3 sentences.
---
You are being asked to familiarize yourself with the repository
at `{{repo_path}}`. This is preparation work — the user will
follow up with actual tasks in subsequent messages using the
same session, so the context you build here is the context
those tasks will rely on.

Read thoroughly. Do not skim. Do not modify any file inside
`{{repo_path}}` — the only file you should write is your
workspace plan at `{{assignment_path}}`.

Work the tasks in order. Each task builds context that the
later ones depend on; the final self-check pulls from your
accumulated notes to confirm you've actually absorbed the
project.

The Notes block on each task is not a deliverable for the user
to read — it's scratch space for *you*, the agent, to make your
understanding explicit. Concrete, specific notes (with file
paths) are far more useful than vague summaries, both for the
user's follow-up work and for anyone inspecting the run
afterward.

**Delegating via subagents.** For a large or unfamiliar
codebase, you may delegate independent tasks to subagents to
parallelize — e.g. run `inventory_structure`,
`identify_entry_points`, and `capture_conventions`
concurrently while you continue reading the primary docs. Do
not delegate `read_primary_entry_points` (primary docs) or
`self_check_summary`; both need to live in the main
agent's context so follow-up tasks inherit them. When a
subagent returns, fold its findings into the task's Notes
block so the main session has a single consolidated view.
Delegation is optional — for a small project, working the
tasks yourself is usually faster.
