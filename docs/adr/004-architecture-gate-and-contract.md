# ADR-004: Architecture Gate and Mandatory-Precision Contract

## Context
Not every request needs a structural decision — trivial additive changes
shouldn't pay for full architecture ceremony. But when architecture does
run, its output must be precise enough for backend and frontend
implementation to proceed independently and in parallel.

## Decision
A deterministic check decides whether a request needs a full Architecture
Agent pass (touches module boundaries, data ownership, or a new dependency)
or can skip straight to implementation with a one-line note.

When the Architecture Agent does run, its contract is not schema-optional,
but precision is enforced by review, not by a schema field or a runtime
branch: `review_arch` (ADR-009) explicitly scores whether the contract is
precise enough for backend and frontend implementation to proceed
independently. If not, `review_arch` signals fail, and the signal graph
(ADR-011) routes back to the Architecture Agent automatically. There is no
separate sequential-vs-parallel decision at runtime — vagueness is caught
and corrected before implementation ever starts, not routed around.

## Consequences
- A workflow with no architecture step at all (a fully additive workflow)
  must not let its code and test steps share the same dependency without a
  contract existing — this is a static check at workflow-load time, not a
  runtime decision.
- Vague architecture output costs a review-triggered retry of the
  Architecture Agent, not a fallback execution mode.
