# ADR-020: Context Management Delegated to Host Coding Agent

## Context
A prior design specified this system's own context-overflow handling
(triage-then-load, explicit compression with a logged note, explicit failure
rather than silent truncation). Since execution now drives an external
coding agent CLI (ADR-007) rather than calling a model API directly, that
CLI already performs its own context management, and duplicating a second,
uncoordinated layer on top would conflict with it rather than help.

## Decision
Context management is the host coding agent's responsibility, not this
system's. Where the host exposes a plugin/hook mechanism around its own
context compaction, use it narrowly to preserve this system's own control-
plane state (current phase, active step, task id) across a compaction event
— never to reimplement general-purpose compaction logic.

## Consequences
- The original explicit-failure-on-overflow guarantee no longer applies at
  this system's layer; it depends entirely on the host CLI's own behavior,
  which may differ across hosts and versions.
- Per-step token cost is governed by how narrowly a step's task is scoped
  (ADR-024), not by any context-budget mechanism owned by this system.
