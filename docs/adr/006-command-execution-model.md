# ADR-006: Command Execution Model

## Context
Real build/test verification (ADR-001) requires running literal, project-
specific commands. These commands depend on this project's actual folder
layout and cannot be generic across projects, but a workflow also needs the
ability to declare ad hoc scripts without pre-registering them.

## Decision
`commands.toml` is a project-local file of named command groups (e.g.
`[validate]`, `[test.unit]`, `[test.integration]`), owned and updated by the
Architecture Agent at project init and on structural change. It is a
validation-gate data source only — no agent invokes commands directly or
constructs them at runtime.

A workflow step of `type: script` executes a command group deterministically,
via either:
- `command: <key>` — resolves a key from `commands.toml`, or
- `inline: "<command>"` — a literal command declared directly in the
  workflow file, for one-off scripts not worth registering.

A script step's pass/fail signal (ADR-011) is its real exit code — never an
agent's interpretation of output.

## Consequences
- Script steps are cheap (no LLM call) and should be used liberally —
  before every retry, before every merge, wherever a real check is cheaper
  than trusting an agent's report.
- Changing what a named command group actually runs is a structural
  decision, made by the Architecture Agent, not a per-request choice by any
  other agent.
