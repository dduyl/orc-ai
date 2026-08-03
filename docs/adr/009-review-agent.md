# ADR-009: Review Agent

## Context
Schema validation (ADR-012) catches structural problems; it cannot judge
quality — whether a contract is precise, whether code handles a real edge
case, whether a test asserts on the right thing. That needs an agent, but
one agent, not one per artifact type.

## Decision
A single Review Agent, parameterized by artifact type at call time, follows
every artifact-producing step. It emits a pass/fail signal (ADR-011),
calibrated to the type and real risk of the artifact — a payment-path
function is held to a higher bar than a copy-text change. On fail, the
signal graph routes back to the originating step automatically; there is no
separate dispatcher deciding which agent is at fault, because review is
scoped to exactly one artifact at a time.

Feedback must be specific and actionable — what is wrong and why it
matters — since it is what the retried step acts on directly. A legitimate
stylistic difference is noted, not failed.

## Consequences
- Because review is per-artifact, the ambiguity a "Failure Triage" dispatcher
  would have resolved (which of several agents caused a downstream failure)
  does not arise — that role is intentionally not part of this design.
- Retry-count tracking lives in the workflow's loop-detection mechanism
  (ADR-017), never in the Review Agent's own output.
