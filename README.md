# orc-ai

A personal AI code orchestrator: describe a feature or fix in plain language, and it drives an existing coding agent CLI through a structured, reviewed pipeline — spec, architecture, implementation, tests, and real build/test verification — instead of a single unstructured coding session.

## Why this exists

A single long-running agentic coding session tends to lose track of decisions, skip edge cases, and self-report success without real verification. orc-ai instead breaks a request into a small graph of steps — each handled by a specialist role, each checked before the next one proceeds — and never lets an agent's own claim of "this works" be the final word. Real build and test commands decide that.

## How it works, briefly

1. You describe a request, either through a slash command in any MCP-compatible coding CLI (Claude Code, Codex, Gemini CLI, OpenCode, etc.) or directly against the built-in CLI/GUI.

2. A **Planner** matches the request to a registered workflow, or generates one on the fly if none fits.

3. A **Harness** runs the workflow's steps — a signal-based graph, not a rigid fixed sequence — dispatching each step to the coding agent CLI it drives, in parallel wherever the graph allows it.

4. Each produced artifact (spec, architecture contract, code, tests) is reviewed before the workflow proceeds; a rejected artifact routes back to the step that produced it automatically.

5. Real commands — build, lint, test — verify the result deterministically. Progress is checkpointed after every step, so an interrupted run can resume without starting over.

## Project layout

```
src/
  core/            shared types and schemas
  adapters/        MCP server, streaming, hooks
  application/      planner, harness (orchestrator, execution, persistence), agents
  workflows/        built-in workflow definitions (YAML)
  delivery/         CLI, GUI, TUI entry points
docs/
  README.md         architecture overview (target design)
  adr/              one file per architecture decision, with a tracked status index
```

## Documentation

- [`docs/README.md`](docs/README.md) — architecture overview: the three-layer model (Planner / Harness / Agents), core design guarantees, and how the rest of the docs are organized.
- [`docs/adr/README.md`](docs/adr/README.md) — the full set of architecture decisions, each tagged with whether it's Accepted or Proposed, and whether it's actually Implemented, Partial, Not Implemented, or Unverified in the current codebase.

## Status and scope

This is a solo, evolving project, not a polished product — expect gaps between what's documented as decided and what's actually running. The ADR index is the most honest source for that gap; when in doubt, trust it over prose descriptions elsewhere.
