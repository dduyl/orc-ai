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
| 001 | Deterministic Validation as Ground Truth | Accepted | Implemented | `type: script` steps gate on a real exit code; built-in workflows (`feat-impl-builtin`, `bug-fix-builtin`) now gate code + tests through script gates with repair feedback to the producer |
| 002 | Code Graph via CodeGraphContext | Accepted | Implemented | Integrated CodeGraphService, exposed code_graph_query MCP tool, and context hint for Architecture Agent |
| 003 | Index File Ownership by Convention | Accepted | Unverified | Whether specs.json/adrs.json/etc. are actually written was not confirmed |
| 004 | Architecture Gate and Mandatory-Precision Contract | Accepted | Partial | Gate exists via a review step; contract is schema-optional, not enforced as precise |
| 005 | Test Timing and Target | Accepted | Unverified | Actual agent prompt content not inspected |
| 006 | Command Execution Model | Accepted | Implemented | CommandExecutor + `type: script` step in the runner gate on a real exit code |
| 007 | Runtime Substrate: PTY-Driven Coding Agent | Deprecated (see ADR-026) | Implemented | Confirmed: adapter-pty.ts, PTY/MCP race, strategy files. Superseded by ADR-026 — the code still works, but the substrate decision is replaced |
| 008 | Bounded Research Tool-Calls per Agent Step | Accepted | Implemented | Enforced checkResearchBudget (max 5 calls for spec/arch, restricted for non-research roles) with unverified_assumption fallback |
| 009 | Review Agent | Accepted | Partial | A review step exists; single-parameterized-agent design not confirmed |
| 010 | Checkpointing, Crash Recovery, and Session Reuse | Accepted | Partial | Checkpointing confirmed real; session-id reuse extension not built |
| 011 | Signal-Based Step Graph | Accepted | Implemented | Steps declare `emits`/`on`/`any` signal refs (`stepId.signal`); `__start__` seeds entry steps; script gates emit a pass/fail signal; redo loops via `any` edges with repair feedback; graph validated at load |
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
| 022 | Quota Handling Strategy | Accepted | Implemented | Escalation ladder: classify quota vs rate-limit at the catch seam (`AgentCallError.kind`), rate_limit → bounded backoff honoring `Retry-After`, quota → downgrade model variant (ADR-021 seam; no routing built) → checkpoint + pause + daemon auto-resume (ADR-010 ext.) → defer `optional` steps; always surface. Implemented: classification/backoff; `quota_exhausted` failure reason; full quota surfacing (Tracker `steps_json.quota` + `paused` status, ProgressEvent/step_finish `quota` payload, GUI `quota-banner`, TUI pause line, step_finish hook event, `[quota]` prefixed Tracker error); Tier 1 downgrade transport (`set_config_option {model}` + same-session re-prompt via injectable `resolveDowngradeModel` callback); Tier 2 pause + daemon wake-timer auto-resume (`reset_at_ms` persisted on the run, resume re-dispatches quota-failed steps, `reconcileStaleRuns` skips paused runs, manual `resume: true` when no window) |
| 023 | Terminal Output Compression via RTK | Proposed | Partial | Decision stays Proposed: the RTK-vendoring approach in ADR-023 is not implemented. A separate self-contained compressor (`src/application/harness/execution/output-compress.ts`) was built instead and wired into `buildRepairPrompt` for failed-gate repair prompts (ANSI strip, blank/duplicate-line collapse, head/tail windowing, error-line survival, 64KB cap). `ctx.buildResults` stays raw. Agent-side command output (Proof Path 2) is handled by the host's rtk PreToolUse hook, not ORC |
| 024 | Concise Agent-to-Orchestrator Summaries | Proposed | Not Implemented | Prompt-only change, not yet applied to any role's prompt |
| 025 | Detached Daemon Run Host with Attachable GUI | Accepted | Implemented | Phase A: migrated all 3 consumers to `node:sqlite` (Checkpointer/Tracker/run-db). Phase B/C: frame transport + TerminalStore + daemon control protocol. Phase D: daemon hosts MCP :3100 (`orc mcp`), owns main terminal + `input` RPC, GUI is a pure `PipeClient` (`daemon-bridge.ts`, `pty-manager.ts`/`run-db.ts` deleted, zero native deps), `node-pty` host-only ABI; daemon survives GUI close. D-3 (main PTY passthrough) superseded by ADR-026 — the `__main__` terminal now renders ORC's ACP chat instead of the agent's TUI |
| 026 | Runtime Substrate: ACP-Driven Coding Agent | Accepted | Partial | Supersedes ADR-007 (PTY) and ADR-025 D-3 (main PTY passthrough). Covers both step subagents and the main interactive session. PR 1 (`feat/acp-substrate`): protocol client + acp-opencode/acp-claude strategies + adapter dispatch shim + step render bridge (tool-call diffs → terminal lines) + hook pass-through for Tracker — live; main session still PTY. PR 2 (`feat/acp-main-client`): main session ACP-backed — daemon-bridge forwards structured `chat-frame`s; GUI renders a DOM chat panel (`chat-view.ts`) with Chat/Terminal view tabs, a permission dialog driven by `requestPermission` options, and a terminal themed to DESIGN.md tokens; step subagents (PR 1) remain live |

## When a later ADR replaces an earlier one

Mark the older row's **Decision** column `Deprecated (see ADR-0XX)` in this
table. Do not edit the older ADR's body — its content remains the accurate
historical record of what was decided and why at the time. The new ADR's own
file states the replacement decision in full; this index is only the
pointer between them.
