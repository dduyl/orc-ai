# ADR-014: Planner / Harness / Agents Layering

## Context
"What should happen" (deciding architecture gates, workflow selection) and
"how it happens safely" (execution, retries, checkpointing, tool access)
are different responsibilities and should not be blurred into one
undifferentiated "orchestrator" concept.

## Decision
Three layers:
- **Planner** — decides what should happen: matches a request to a
  registered workflow, or generates one dynamically (ADR-017); never
  executes anything itself.
- **Harness** — decides how it happens safely: the step graph (ADR-011),
  checkpointing (ADR-010), command execution (ADR-006), schema enforcement
  (ADR-012), bounding (ADR-017). Guardrails live here, enforced by code, not
  by prompt text alone, wherever that enforcement actually exists.
- **Agents** — do the work: Requirement Analyst, Architecture Agent,
  Codegen, Testgen, Review Agent.

## Consequences
- A feature request phrased as "let the orchestrator decide" should be
  routed to the layer whose actual job that is — most "decide what" requests
  belong to the Planner, not to a Harness mechanism, and vice versa.
- This layering is a naming and responsibility discipline, not a runtime
  enforcement mechanism by itself — enforcement still depends on each
  underlying ADR being actually implemented.
