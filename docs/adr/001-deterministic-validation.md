# ADR-001: Deterministic Validation as Ground Truth

## Context
LLM agents cannot be trusted to self-report whether generated code actually
works. An agent asked "did this pass?" can only describe intent, not
observed fact.

## Decision
Whether an artifact is correct is decided exclusively by deterministic code
execution — a real build, lint, or test command with a real exit code —
never by an agent's own claim. This principle governs two concrete
mechanisms: script steps (ADR-006) for build/test/lint verification, and the
Conformance Check (ADR-013) for cross-artifact consistency. Both exist
because of this principle; this ADR states the principle itself and is
never satisfied by an agent narrating success.

## Consequences
- Any step whose "pass" signal is decided by an LLM interpreting its own
  output (rather than a real exit code or a structural comparison) violates
  this ADR, regardless of how the step is otherwise wired.
- Retrying an agent because a script step failed is legitimate; treating an
  agent's self-reported success as sufficient to proceed is not.
