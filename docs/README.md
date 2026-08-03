# AI Code Orchestrator — Architecture

A personal, reusable system that turns natural-language build/feature requests into working code, tests, and documentation, across multiple tech stacks. Workflows are data — YAML files describing a signal-based graph of steps, where each step declares what it emits and what it listens for, rather than a fixed pipeline. Execution works by driving an existing coding agent CLI directly over a pseudo-terminal, rather than reimplementing file editing and tool-calling from scratch. A Harness enforces safety uniformly on top of that, regardless of which workflow is running. The system is exposed through its own MCP server, so any MCP-compatible coding CLI can trigger a workflow via a slash command, without depending on that host's own subagent or execution model.

This is a living design, not a status report: not every guarantee below is implemented yet. `adr/README.md` tracks, decision by decision, what's Accepted vs Proposed and what's Implemented vs Partial vs Not Implemented vs Unverified. Treat that table, not this page, as the source of truth for what actually works today.

## Core guarantees (intended design — see `adr/README.md` for what's real today)
- Nothing is trusted on an agent's say-so: every output is meant to be schema-validated (structure) and Review Agent-rated (quality), and real build/test/migration commands run through deterministic script steps, never claimed by an LLM.
- Workflows describe *coordination* only — which step listens for which signal, and whether it needs all of them or just one — never *safety*. The Harness enforces validation, ownership, retries, and bounding the same way no matter which workflow is running.
- The system never depends on any coding CLI's own subagent format — specialist agents are invoked by driving the underlying coding CLI directly, so switching coding CLIs never requires redefining agents.
- The pipeline can crash mid-run and resume from already-completed step results, without restarting from scratch.
- Parallel branches run in isolated git worktrees. A step that writes outside its intended scope is caught after the fact and rolled back within its own worktree only, without discarding a sibling branch's correct work.

## Three layers
- **Planner** — decides *what* should happen: matches a request to a registered workflow, or generates a temporary one when no match exists.
- **Harness** — decides *how* it happens safely: resolves the step graph, runs steps in parallel wherever their signals allow it, enforces schema validation, ownership, retries, bounding, and real command execution.
- **Agents** — do the actual work: Requirement Analyst, Architecture Agent, backend/frontend Code Generation Agents, backend/frontend Test Generation Agents, and a single Review Agent parameterized by artifact type.

Given the real gap between design and implementation right now, read this page as the target architecture, and `adr/README.md`'s table as the map of how far implementation has actually gotten.
