## Scope and direction

agent-runner is an orchestration and state-tracking layer for agent runs. Its job is to hold the canonical record of what an agent was asked to do, what it did, and what happened — and to execute that work autonomously once a run, schedule, or dependency graph has been set up.

Upstream design and ideation happen outside agent-runner. The user, or an interactive coding tool the user is working with, decides what should be built and shapes the requirements. What crosses into agent-runner is either an executable plan, or the requirements and scaffolding to produce one. From there, formalizing the plan and running it are agent-runner's job — including the run loop, retries, scheduled firings, and dependency gating. External surfaces (CLI, daemon API, outer agents) are for setup, inspection, and overrides, not for moment-to-moment driving.

The workflow is punctuated, not continuous. The user is involved at a small number of gates — requirements intake, plan review and approval, and final review of the result — while plan formalization and execution happen between those gates with peer-agent review and rule enforcement built in. agent-runner does not assume the user is watching the agent work; it assumes the user will come back at the next gate and needs durable state, audit, and a clear summary when they do.

The execution scaffolding is opinionated and intentionally inflexible. Run lifecycle, task state, and the rule that workers report progress through the task CLI rather than freeform output are core primitives — if those don't fit how you want to work, agent-runner probably isn't the right tool. What runs through that scaffolding is not opinionated: assignments, tasks, agent definitions, hooks, briefs, planning structure, and coding or review guidelines are all user-controllable. The bundled assignments and agents in this repo are working examples shaped to one workflow, not a required path; you can replace, extend, or ignore them.

Active backend mode supports the same tools you already use interactively (`claude`, `codex`, `cursor-agent`, `pi`). Backend-native capabilities like skills, subagents, MCP servers, and custom slash commands continue to work; agent-runner controls when and how the backend is invoked, not what it does once running. Reimplementing those backend-native capabilities inside agent-runner is not a goal.

agent-runner is not an interactive coding environment. It does not aim to replace Claude Code, Cursor, Codex, or any other tool you use to converse with an agent in the moment. It has no editor, no chat-first UI, and no ambition to become the primary place a user writes code, refines work conversationally, or does upstream planning and ideation.

In practice it is used either as a sidecar to those interactive tools, or as a runner driven by an outer system that needs durable state, structured handoffs, and audited outcomes.

## Non-goals

agent-runner deliberately does not pursue:

- a remote multi-user control plane
- workspace-file task editing as a first-class workflow
- backward-compatibility shims for removed manifest or CLI contracts
- automatic proof that a worker really performed a task

## Feature triage heuristic

Feature requests that push agent-runner toward being a richer in-product
experience for talking to or working alongside an agent are generally
out of scope. Examples include chat rendering, inline editing,
conversational refinement, IDE-like surfaces, and upstream planning or
ideation workflows.

Narrow controls that persist run intent remain in scope even when they
appear near Chat. For example, queued resume messages for a live run are
manifest state and daemon-owned pending intent, not an interactive
backend conversation or live interrupt surface.

Requests to make the core primitives more flexible are also generally
out of scope: run lifecycle, task-state model, and the task CLI as the
completion channel are intentional boundaries. Reimplementing
backend-native capabilities such as skills, subagents, MCP servers, or
custom commands inside agent-runner is also out of scope.

Feature requests that strengthen run state, lifecycle, orchestration,
audit, scheduling, hooks, briefs, dependencies, external-driver
ergonomics, or user-authored assignments, agents, hooks, and templates
are generally in scope.
