# ADR-003: Index File Ownership by Convention

## Context
Multiple agents produce decision/history artifacts (specs, ADRs, test
cases, reviews). If any agent could write to any index file, entries could
race or be edited by the wrong party.

## Decision
Each artifact type gets its own index file, with exactly one intended
writer:
- `specs.json` — Requirement Analyst
- `adrs.json` — Architecture Agent
- `testcases.json` — Test Generation Agent
- `reviews.json` — Review Agent
- `change-log.json` — Orchestrator

Each entry is a menu item only (id, title, summary, tags, file path) — never
the full document body. Enforcement is by prompt instruction and workflow
wiring (each agent is only ever invoked in a role that writes its own file),
not by a filesystem-level gateway — see ADR-015 for why a real-time write
gateway was rejected in favor of convention plus post-hoc checks.

## Consequences
- Any agent may read across all index files during triage.
- No merged master index is ever persisted; cross-file lookups happen at
  read time only.
- Because enforcement is by convention, a workflow step that misroutes an
  agent (e.g. invokes Review Agent in a role expected to write `specs.json`)
  is a workflow-authoring bug, not something this system detects at runtime.
