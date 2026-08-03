# ADR-007: Runtime Substrate — PTY-Driven Coding Agent

## Context
The original design called for a LangGraph state machine calling LLM
providers directly. In practice, execution reuses an existing, capable
coding agent CLI (e.g. an OpenCode- or Claude Code-class tool) rather than
reimplementing file editing, shell access, and tool-calling from scratch.

## Decision
Each agent step spawns the underlying coding agent CLI in a pseudo-terminal
(PTY), keeping the session alive rather than one-shot. Step completion is
detected by racing two signals: the PTY process's own exit, and the spawned
agent proactively calling back into this system's own MCP server with a
structured result, tagged by a per-step completion key. Whichever resolves
first wins; the losing path is safely discarded, never left to error
unhandled. A filesystem-based hook log is read as a fallback source for the
structured result if the MCP path does not win the race.

The graph topology, retry/escalation policy, and safety gates are owned by
this system, not by the underlying CLI — the CLI is treated as an execution
backend, never as the source of truth for orchestration.

## Consequences
- No LangGraph dependency exists in this system; DAG resolution and
  checkpointing are implemented directly (ADR-010, ADR-011).
- The PTY/MCP race is inherently a source of timing bugs (an already-fixed
  case: a completed MCP callback leaving a dangling PTY promise). Treat this
  path as fragile until proven stable across CLI versions.
- Switching the underlying coding agent CLI means adding a new strategy
  (argument-building, completion detection) — the orchestration layer above
  it does not change.
