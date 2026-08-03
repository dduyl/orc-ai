# ADR-011: Signal-Based Step Graph

## Context
A pure `depends_on` DAG (no cycles) cannot express "redo this step if
review rejects it" without pushing retry logic outside the graph into a
separate dispatcher — which in turn requires guessing which upstream step
caused a downstream failure. A cleaner model lets each step declare what it
listens for, independent of who produces it, and lets cycles exist where a
real workflow needs them (a review step routing back to the step it
reviewed).

## Decision
Each step declares:
- `emits: [signal, ...]` — the fixed set of signal names it may produce.
  A step never names which other step should run next; it only ever emits
  from its own declared vocabulary.
- `on: [stepId.signal, ...]` — this step runs once ALL listed signals have
  fired (AND join). This is the default and preserves the behavior of a
  plain dependency edge.
- `any: [stepId.signal, ...]` — this step runs once ANY one listed signal
  fires (OR join), for cases like "route back to architecture if either the
  code review or the test review fails."

A step must declare exactly one of `on` or `any`, never both — the workflow
loader rejects a step declaring both at load time, rather than resolving the
ambiguity at runtime.

Producers never know their consumers. Adding a new consumer of an existing
signal requires only adding a new step with the right `on`/`any` — the
producing step is never edited.

A cycle created by an `any`/`on` route-back is bounded by the global step
budget and loop detector (ADR-017), not by anything in the graph shape
itself.

## Consequences
- This intentionally reintroduces cycles into what was previously a strict
  DAG. That is a deliberate tradeoff: express retry as ordinary graph edges,
  at the cost of no longer being provably acyclic by construction — safety
  now depends on ADR-017's bound, not on graph shape.
- A workflow file with a producer step that lists its own consumers is
  using the old model and must be rewritten to this one; the two models are
  not interoperable within a single workflow file.
