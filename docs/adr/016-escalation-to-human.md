# ADR-016: Escalation to a Human

## Context
Most ambiguity should be resolved autonomously — a pipeline that pauses on
every uncertain point isn't useful. But some ambiguity is genuinely
consequential, and some pipeline outcomes (exhausted retries, an
unrecoverable environment error) need a human, not another retry. These
were previously three separate, disconnected ideas: an "ask" capability for
Requirement Analyst/Architecture Agent, a `needs_human` status value defined
in the schema but never actually assigned, and a general notion of human-
in/on-the-loop gating. They are one feature.

## Decision
Requirement Analyst and Architecture Agent may ask a real, blocking
question — reserved for cases where BOTH: the wrong guess would require
redoing significant downstream work, AND no reasonable default exists from
this project's own conventions or prior decisions. Every other role only
ever documents an assumption and proceeds.

A run's final status is `needs_human` — not `failed` — whenever the reason
is `loop_detected` or `budget_exceeded` (ADR-017): these indicate the system
itself is stuck, not that a specific step produced bad output. An exhausted
per-step retry budget (schema validation, review, or build failure) also
escalates to `needs_human` rather than terminating as a bare failure.

Gating defaults to human-on-the-loop (autonomous execution, human reviews
after) for ordinary steps. It becomes human-in-the-loop (a blocking gate
before proceeding) when: a review score is borderline rather than a clear
pass or fail, the running workflow was dynamically generated with no prior
approved precedent, the operation is hard to reverse (e.g. a migration
against a real environment), or an agent has invoked its ask-path above.

## Consequences
- The `needs_human` status exists in the schema but the orchestrator
  currently only ever assigns `completed` or `failed` — assigning it
  correctly for the cases above is a concrete, small implementation task.
- No blocking human-in-the-loop gate currently exists at runtime; the
  conditions above describe when one is needed, not a built mechanism yet.
