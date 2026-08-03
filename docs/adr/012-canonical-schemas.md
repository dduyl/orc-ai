# ADR-012: Canonical Schemas Enforced at Every Step Boundary

## Context
Output must be structurally consistent regardless of which underlying model
or agent produced it, so downstream steps and future triage can rely on a
fixed shape rather than parsing free-form prose.

## Decision
One schema exists per artifact type (spec, ADR/contract, code, test, build
result, review result), each versioned. Every step's structured result must
be validated against its type's schema before the step is considered
complete; on validation failure, one bounded self-repair attempt is made
before escalating (ADR-016).

Schema shape is fixed once defined. What is allowed to vary per request is
whether a given artifact is produced at all, and what values populate it —
never its shape.

## Consequences
- Currently, a step's structured result is accepted as a loosely-typed
  object and is not actually run through its schema before being treated as
  complete. This is a real enforcement gap: the schemas exist as
  definitions but are not yet a functioning gate. Closing this gap —
  wiring real validation into the step-completion path — is a priority
  implementation task, not a design change.
- Once closed, a step whose result fails schema validation must be treated
  identically to a failed review signal for retry/escalation purposes.
