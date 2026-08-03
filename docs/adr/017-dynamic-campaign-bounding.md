# ADR-017: Dynamic Campaign Bounding

## Context
A dynamically generated workflow (Planner) has no shape known in advance,
and a signal-based graph (ADR-011) permits cycles by design. Both need a
hard ceiling to prevent runaway execution.

## Decision
Two global bounds apply to every run, regardless of workflow source:
a maximum total step-execution count (50), and a maximum repeat count for
the same step id before it is treated as a detected loop (5). Either bound
being hit ends the run with `needs_human` (ADR-016), not `failed` — this
indicates the system is stuck, not that a specific artifact is wrong.

## Consequences
- These are global, coarse bounds — they do not substitute for a per-step
  research-loop cap (ADR-008), which remains a separate, unimplemented
  refinement.
- A workflow author relying on more than roughly 5 review/retry cycles for
  a single step should treat that as a design smell in the workflow, not a
  limit to raise casually.
