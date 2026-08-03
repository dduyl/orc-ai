# ADR-021: Model Routing by Task Complexity

## Context
Not every step warrants the strongest available model. The Architecture
Gate (ADR-004) already computes a complexity signal (does this touch module
boundaries, ownership, or a new dependency) that can be reused rather than
building a second classifier.

## Decision
Define two variants per role that benefits from it (e.g. a stronger and a
cheaper Architecture Agent variant). The workflow selects the variant based
on the existing Architecture Gate signal — never a new, separately invented
classification.

## Consequences
- Variant selection is a deterministic lookup on an existing signal, not an
  agent's own judgment call.
- Adding a new variant tier later (e.g. a third, mid-cost option) only
  requires extending the same lookup, not new classification logic.
