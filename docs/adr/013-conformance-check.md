# ADR-013: Conformance Check Across Parallel Artifacts

## Context
When code and tests are produced in parallel against a shared contract
(ADR-004), each is reviewed independently, but nothing checks that the two
sides actually agree with each other — a signature drift between them would
not be caught by either review in isolation.

## Decision
A conformance-check step runs once both the code and test artifacts have
passed their individual reviews (`on: [code.pass, test.pass]` — an AND
join, per ADR-011). It performs a deterministic structural comparison
(signatures, types) between the two artifacts and the contract, per ADR-001
— never an LLM's read of whether they seem consistent. On mismatch, it
signals fail and routes back to whichever side actually deviates from the
contract, treating the contract as ground truth.

## Consequences
- This step does not exist yet in any built-in workflow; adding it is a
  workflow-authoring task once the deterministic comparison itself is
  implemented.
- Without it, a code/test signature drift under parallel generation is
  currently only caught later, at real build/test execution (ADR-006),
  which is a valid but more expensive place to catch it.
