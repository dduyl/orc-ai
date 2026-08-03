# ADR-019: Backend/Frontend Agent Role Split

## Context
Backend and frontend implementation and testing require different senior-
engineer judgment (data integrity/concurrency/security vs. UX/accessibility/
design-system consistency). A single generic prompt for either role
underserves one side or the other.

## Decision
Code Generation and Test Generation each have a backend and frontend
variant, with distinct prompts. Review Agent is not split this way — it
stays one role, parameterized by artifact type (ADR-009), since review
criteria differ by artifact type, not by which variant produced it.

## Consequences
- A workflow step referencing an agent role must use the specific variant
  (`code_generation_backend`, not a generic `code_generation`).
- Built-in workflows today route only through backend variants; using the
  frontend variants requires either a custom workflow file or relying on the
  Planner's dynamic generation to select them when a request is clearly
  frontend-scoped.
