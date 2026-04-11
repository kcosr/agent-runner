---
schemaVersion: 1
name: doc-review
sessionName: doc review · {{repo_path}}
vars:
  repo_path:
    type: string
    required: true
    source: cli
    description: Absolute path to the repository whose docs you want reviewed.
tasks:
  - id: t01_inventory
    title: Inventory the documentation surface
    body: |
      First, find every documentation file in the repository at
      `{{repo_path}}`. A "doc file" includes:
        - README(.md, .rst, .txt, or similar) at the repo root
          and in subdirectories
        - Anything under docs/, doc/, documentation/, guides/
        - AGENTS.md, CLAUDE.md, CONTRIBUTING.md, CODE_OF_CONDUCT.md,
          CHANGELOG.md, SECURITY.md
        - Man pages, if present
        - In-code module-level docstrings that are explicitly
          meant to be user-facing (not inline comments)
        - Website source if the repo hosts its own docs site

      Also inventory the code surface enough to know what the
      docs *should* cover:
        - Build manifest (package.json, Cargo.toml, go.mod,
          pyproject.toml, etc.) — commands, dependencies, bin
          entry points
        - Entry-point files (CLI main, library index, HTTP
          handlers, etc.)
        - Any exported public API
        - Any CLI subcommands, flags, env vars

      Notes: a short inventory (under 20 lines) listing the docs
      you found and the code surface you'll check them against.
      This is context for the rest of the review, not a finding
      section.
  - id: t02_elevator_pitch
    title: README elevator pitch & framing
    body: |
      Read the README's opening. A reader who has never heard of
      this project should, within the first 3-5 sentences, know:
        1. What the project *is* (one-liner, not marketing).
        2. What problem it solves.
        3. Who it's for.
        4. What it is *not* (scope boundary), if that's
           non-obvious.

      Check for:
        - Buried lead — the actual description comes 200 lines
          down after installation or a features list
        - Jargon in the first sentence that the reader couldn't
          know yet
        - "Framework for X" / "tool for Y" without ever saying
          what X or Y concretely are
        - Claims about what the project does that require
          knowing the project to parse
        - Missing "why" — the README explains what it does but
          not why you'd use it instead of the obvious alternative

      Format per role instructions.
  - id: t03_quickstart
    title: Quickstart runnability & completeness
    body: |
      Find the quickstart or getting-started section. A good
      quickstart lets a new reader copy-paste commands and see
      concrete results within a few minutes.

      Check for:
        - Missing prerequisites (required runtimes, binaries,
          env vars). Cross-reference against the build manifest
          and the code's actual external dependencies.
        - Commands that can't work as written. Trace each one
          mentally: does the binary exist at that path, does the
          flag exist in the current code, does the argument
          order match the parser?
        - No example output — the reader runs the command and
          doesn't know whether it worked.
        - Assumes the reader already knows how to install the
          project (e.g. starts with "just run X" but X is a
          binary built in a later step).
        - Drops into the deep end immediately without a minimal
          working example.

      Broken quickstart commands are CRITICAL. Grep/read the
      code to confirm before flagging.
  - id: t04_concepts
    title: Conceptual clarity & terminology
    body: |
      Walk through the README's concept section (or equivalent)
      and check:
        - Are domain-specific terms introduced before they're
          used elsewhere in the doc?
        - Is terminology consistent? (If section A calls
          something a "run" and section B calls it an
          "invocation" without saying they're the same thing,
          that's drift.)
        - Does the doc's mental model match the code's? E.g. if
          the doc implies X is a kind of Y but the code treats
          them as siblings, the doc is misleading.
        - Are relationships between concepts clear? (Which
          things are composed of which others, which things are
          alternatives to each other.)

      This task often catches the biggest readability wins —
      name a thing clearly once and the rest of the doc
      improves.
  - id: t05_commands_flags_api
    title: Commands, flags, and API reference accuracy
    body: |
      For every CLI subcommand, flag, function signature, or
      HTTP endpoint mentioned in the docs, verify it against
      the code. Specifically:
        - Flag names (`--foo` vs `--bar`): grep the parser.
        - Flag defaults: read the code, compare to the doc.
        - Argument types and required vs optional.
        - Subcommands: does every documented subcommand exist?
          Are there subcommands in the code that aren't
          documented?
        - Env vars: are all user-facing ones documented? Do
          their defaults match the code?
        - Exit codes: does the documented table cover every
          `process.exit`/`exit(N)` call with a meaningful code?
        - Schema fields (config files, request/response
          payloads): do the documented fields and types match
          the schema definitions?

      Drift here is **CRITICAL** — it silently ships users onto
      the wrong path. For each inaccuracy, quote both sides
      (doc line + code line) and propose the replacement
      wording.
  - id: t06_examples
    title: Examples, tutorials, and recipes
    body: |
      Walk every example in the docs — shell commands, code
      snippets, config files, curl invocations, anything
      intended to be run or copied.

      For each, check:
        - Does it use a command/flag that actually exists in
          the current code?
        - Are the file paths real? (A docs snippet referencing
          `src/foo.ts` is broken if that file was renamed.)
        - Would a reader who copies this verbatim get the
          claimed result, or would they need to also do three
          undocumented setup steps?
        - Is the output shown, or does the example end before
          the reader knows whether it worked?
        - Is the example minimal? Padded examples (long config
          blocks with fields irrelevant to what's being shown)
          hide the actual point.
        - Are "advanced" examples actually advanced, or are
          they the same minimal example with an extra flag?

      Broken examples are CRITICAL.
  - id: t07_completeness_gaps
    title: Completeness — undocumented features
    body: |
      Walk the code surface you inventoried in t01 and list
      features that aren't mentioned in the docs at all, or are
      mentioned only in passing. Candidates:
        - CLI subcommands the docs don't describe
        - Config fields the docs don't mention
        - Env vars the code reads that the docs don't list
        - Important lifecycle behavior (abort handling, resume,
          cleanup) that's implemented but not described
        - Safety/guardrail features (timeouts, retries, depth
          caps) that users should know about
        - Backend differences or edge cases the user will hit
        - Error codes / failure modes the user will encounter

      A missing feature in docs is **HIGH** (users can still
      find it by reading the code or --help). A stale claim is
      **CRITICAL** because it actively misleads.
  - id: t08_structure_navigation
    title: Structure & navigation
    body: |
      Zoom out to the README's structure. Does the table of
      contents match the section order? Is the section order
      useful — install → quickstart → concepts → reference —
      or does it bury the things a new reader needs? Are
      subsections nested too deep to find? Are there orphan
      sections that don't connect to anything?

      Also check cross-references: if README.md says "see
      docs/design.md" does that file exist and cover what
      was claimed? If multiple docs cover the same thing,
      is the relationship between them clear (which one is
      canonical)?

      For projects with multiple top-level docs (README,
      CONTRIBUTING, etc.), is the split sensible or is content
      in the wrong file?
  - id: t09_diagrams
    title: Diagrams — propose mermaid blocks where they help
    body: |
      Identify the parts of the docs where a diagram would
      clarify something that's currently (a) described as
      prose, (b) described as a bulleted list of interactions,
      or (c) not described at all but would benefit from
      visualization.

      Favor these diagram types:

      - **Component architecture** (mermaid `graph TD` or
        `flowchart TD`). Boxes are modules or subsystems,
        arrows are "calls into" / "depends on", groupings are
        layers. Use this when the project has multiple
        subsystems that talk to each other and the reader
        currently has to reconstruct the architecture by
        opening ten files.

      - **Sequence / ladder diagrams** (mermaid
        `sequenceDiagram`). Participants are major components
        or actors, messages are method calls / API requests /
        events. Use this for runtime flows that cross multiple
        layers: "what happens on a fresh run", "what happens
        when the user hits Ctrl+C", "what happens on resume
        from a persisted state", "what happens during a
        retry". These are almost always better as a ladder
        than as prose.

      - **State diagrams** (mermaid `stateDiagram-v2`).
        States are the values of a lifecycle enum (e.g.
        `initialized → running → {success, blocked, error,
        aborted}`), transitions are the events that move
        between them. Use this whenever the project has a
        small-state-machine domain concept.

      For each diagram you propose:
        1. Name the doc file and the section where it should
           go.
        2. Write the mermaid block fully, ready for the human
           to paste in.
        3. Add a one-sentence caption explaining what the
           diagram is meant to clarify.

      Only propose diagrams that actually add information. A
      diagram that restates a list of components as boxes is
      noise. If the project is small or the existing prose is
      already clear, it's fine to propose zero diagrams and
      say so.
  - id: t10_voice_consistency
    title: Voice, tone, and consistency
    body: |
      Read the docs end-to-end and listen for:
        - Voice drift — one section in marketing voice, another
          in chat-with-a-colleague voice, another in stiff
          third-person reference voice.
        - Pronoun inconsistency — "you" vs "we" vs passive
          without a clear rule.
        - Formatting inconsistency — bullets vs numbered lists
          for parallel content, code blocks styled differently,
          headers using different capitalization rules.
        - Fenced code blocks without language tags (breaks
          syntax highlighting).
        - Tables where prose would be clearer, or prose where
          tables would be clearer.

      This is the lowest-severity dimension; only flag things
      that a reader would actually notice. Skip pure
      preference.
  - id: t11_accessibility
    title: Accessibility & assumed knowledge
    body: |
      Who is the reader the docs are written for, and does the
      doc meet them where they are? Look for:
        - Jargon the reader couldn't be expected to know
          without explanation
        - Assumed tooling knowledge (git, docker, cloud
          provider specifics) that isn't called out as a
          prerequisite
        - Acronyms introduced without expansion
        - Commands that won't work on some platforms without a
          note (Windows vs POSIX shells, macOS vs Linux path
          differences)
        - Screenshots or diagrams with no alt text or text
          equivalent
        - "Obvious" steps that are only obvious to someone who
          already knows the project
  - id: t12_synthesis
    title: Top findings synthesis
    body: |
      Now read back through the notes you wrote on tasks t02-t11
      and build a single ranked list of the **top 10
      highest-leverage findings** from the entire review. Order
      by severity (CRITICAL first, then HIGH, MEDIUM, LOW) and
      within a severity by impact. Each entry must reference
      the original finding's file:line so the reader can jump
      back.

      If you found fewer than 10 real issues, list the real
      ones and stop. Padding is worse than a short review.

      Also include:
        - One sentence on the docs' overall health (are they
          honest, runnable, and respectful of the reader's
          time?)
        - The single highest-leverage fix (if any) that would
          unblock or improve many readers at once
        - A short list of the diagrams you proposed in t09
          with their target sections, so the human has a
          single place to find them
---
You are reviewing the documentation of the repository at
`{{repo_path}}`. Treat that path as the root for everything you
read. Do not modify any file inside that repo — the only file
you should write is your workspace plan at
`{{assignment_path}}`.

Work the tasks in order. Earlier tasks inventory and frame the
review; later tasks build on that context; the synthesis task
pulls from your accumulated notes.

This is a documentation review, not a rewrite. Your job is to
find everything wrong or missing and describe the fix
concretely enough that a human can act on it. You are not
writing the new docs. The exception: when a diagram would help,
write the mermaid block fully in the notes so the human can
paste it in directly.

The canonical reference for what "good" looks like on a README
is the one in this project's own `/home/kevin/worktrees/task-runner/README.md`.
Its structure (elevator pitch → table of contents → why →
features → install → quickstart → concepts → commands →
backends / runtime flows → configuration reference → examples
→ development → project layout → pointer to deeper docs → tone)
is a reasonable default target for most tool-like projects.
Cite it as a reference if it helps, but don't demand that every
project match it verbatim — match its *spirit* (honest, runnable,
reader-first, short where possible) not its exact sections.

A dimension with no real issues produces no findings in that
task. Say "No issues found in this dimension" and move on.
Padding the review to look thorough is worse than a short
honest review.

**Delegating via subagents.** For a large doc set, you may
delegate independent dimensions to subagents to parallelize —
e.g. run the commands/flags/API accuracy pass (t05) and the
examples runnability pass (t06) as separate subagents while
you continue with the structure pass. Do not delegate the
inventory task (t01) or the synthesis task (t12); both depend
on your own accumulated context. When a subagent returns,
fold its findings into the task's Notes block in the same
severity/format used by the rest of the review so the
synthesis pass sees a consistent shape. Delegation is
optional — for a small project, working the tasks yourself is
usually faster.
