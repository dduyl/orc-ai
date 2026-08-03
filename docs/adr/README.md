# Architecture Decision Records — Index

Each ADR file's content is stable once written — never edited to reflect
implementation progress or deprecation. All tracking lives here, in this
table, so adding a status update never touches an ADR body.

**Decision** = has this design been agreed on (Accepted / Proposed /
Deprecated / Rejected). **Implementation** = does the code actually do this
yet (Implemented / Partial / Not Implemented / Unverified — distinct from
Not Implemented, meaning nobody has actually checked). Based on direct
source inspection of the real repo as of this writing; re-verify before
trusting an "Implemented" mark after further changes.

| # | Title | Decision | Implementation | Notes |
|---|---|---|---|---|
| 001 | Deterministic Validation as Ground Truth | Accepted | Not Implemented | Depends on 006/011; test steps currently self-reported by the agent |
| 002 | Code Graph via CodeGraphContext | Accepted | Not Implemented | Not wired into Architecture Agent's tools |
| 003 | Index File Ownership by Convention | Accepted | Unverified | Whether specs.json/adrs.json/etc. are actually written was not confirmed |
| 004 | Architecture Gate and Mandatory-Precision Contract | Accepted | Partial | Gate exists via a review step; contract is schema-optional, not enforced as precise |
| 005 | Test Timing and Target | Accepted | Unverified | Actual agent prompt content not inspected |
| 006 | Command Execution Model | Accepted | Not Implemented | No CommandExecutor or `type: script` step exists |
| 007 | Runtime Substrate: PTY-Driven Coding Agent | Accepted | Implemented | Confirmed: adapter-pty.ts, PTY/MCP race, strategy files |
| 008 | Bounded Research Tool-Calls per Agent Step | Accepted | Not Implemented | Only the global bound (017) currently applies |
| 009 | Review Agent | Accepted | Partial | A review step exists; single-parameterized-agent design not confirmed |
| 010 | Checkpointing, Crash Recovery, and Session Reuse | Accepted | Partial | Checkpointing confirmed real; session-id reuse extension not built |
| 011 | Signal-Based Step Graph | Accepted | Not Implemented | Current code uses an older single-target `signal_on`/`signal_off`, not `emits`/`on`/`any` |
| 012 | Canonical Schemas Enforced at Every Step Boundary | Accepted | Partial | Schemas defined; confirmed NOT validated at the step-completion path |
| 013 | Conformance Check Across Parallel Artifacts | Accepted | Not Implemented | No such step exists in code |
| 014 | Planner / Harness / Agents Layering | Accepted | Implemented | Confirmed: matching directory structure exists |
| 015 | Parallel Isolation via Worktrees and Ownership | Accepted | Not Implemented | No worktree usage found; new decision from this round |
| 016 | Escalation to a Human | Accepted | Not Implemented | `needs_human` defined in schema, never assigned; no ask-path found |
| 017 | Dynamic Campaign Bounding | Accepted | Implemented | Confirmed: MAX_STEPS=50, MAX_LOOP=5 |
| 018 | MCP Prompts as Portable Invocation Surface | Accepted | Partial | MCP server confirmed; use of the "prompts" primitive specifically not confirmed |
| 019 | Backend/Frontend Agent Role Split | Accepted | Partial | Roles declared; built-in workflows use backend variants only |
| 020 | Context Management Delegated to Host Coding Agent | Accepted | Implemented | True by default (no competing logic built); the suggested preservation hook is Not Implemented |
| 021 | Model Routing by Task Complexity | Proposed | Not Implemented | New this round |
| 022 | Quota Handling Strategy | Proposed | Not Implemented | New this round |
| 023 | Terminal Output Compression via RTK | Proposed | Not Implemented | New this round |
| 024 | Concise Agent-to-Orchestrator Summaries | Proposed | Not Implemented | Prompt-only change, not yet applied to any role's prompt |

## When a later ADR replaces an earlier one

Mark the older row's **Decision** column `Deprecated (see ADR-0XX)` in this
table. Do not edit the older ADR's body — its content remains the accurate
historical record of what was decided and why at the time. The new ADR's own
file states the replacement decision in full; this index is only the
pointer between them.
