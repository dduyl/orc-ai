# ADR-010: Checkpointing, Crash Recovery, and Session Reuse

## Context
A long-running campaign can be interrupted by a process crash, a closed
terminal, or a dropped connection. Restarting from scratch wastes already-
completed work and burns tokens re-running steps that already succeeded.
Separately, retrying a single failed step by spawning a brand-new agent
session discards useful context the failed attempt already built up.

## Decision
Step outcomes are persisted after every step completes, keyed by a stable
task identifier, in a local embedded database — not a coarse per-run
snapshot. On resume, every step whose recorded status is not `failed` is
restored without re-running; only incomplete or failed steps execute again.
Checkpoints are pruned only once a run completes with zero failures;
runs that ended with any failure keep their checkpoint available for
resume.

Extension (not yet implemented): when retrying a single failed step, the
persisted state should also carry the underlying coding agent's own session
identifier (ADR-007), so a retry resumes that same session — preserving its
existing context — rather than spawning a fresh one. This depends on the
underlying CLI's session-resume support, which should be treated as
possibly unreliable across versions; a resume attempt that hangs past a
timeout should fall back to a fresh session rather than block indefinitely.

## Consequences
- Resume is triggered explicitly (a caller-supplied flag), not auto-detected
  from an ungraceful prior exit.
- Session-id reuse, once implemented, reduces the token cost of retries
  measurably, since a resumed session already holds prior context instead
  of rebuilding it from nothing.
