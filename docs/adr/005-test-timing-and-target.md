# ADR-005: Test Timing and Target

## Context
Writing test files before real code exists forces guessing at API shape.
Testing implementation details instead of behavior produces tests that
break on harmless refactors.

## Decision
Test scenarios and testability requirements are decided at spec/architecture
time. Test files are written by the Test Generation Agent only after real
code exists, and assert on observable behavior and the contract — public
inputs/outputs, rendered output, returned/emitted values — never on private
methods, internal call order, or incidental data structures.

## Consequences
- A test that breaks on a pure refactor with no behavior change indicates a
  test-design fault, not a fault in the refactor.
- Unit tests may reasonably couple to a unit's own public interface;
  integration/e2e tests should not couple to internals at all.
