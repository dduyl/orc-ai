# ADR-023: Terminal Output Compression via RTK

## Context
Real command execution (ADR-006) produces raw terminal output (build logs,
test results, git status) that is often far larger than what an agent
needs to act on it. An external tool (RTK) already performs rule-based,
command-aware compression (filtering, grouping, truncation, deduplication)
well; this should be adopted rather than reimplemented.

## Decision
The script-step executor (ADR-006) wraps every command through RTK
internally, as part of its own implementation — not as a separately
configured, host-wide hook the user manages outside this system. This
keeps command-output compression an owned, documented part of this
system's behavior rather than an external dependency floating beside it.

## Consequences
- RTK is a vendored dependency of the script-step executor; pin its version
  the same way CodeGraphContext's version is pinned (ADR-002).
- This is purely an output-size optimization for structured command output;
  it does not address prose/summary token cost, which is handled separately
  (ADR-024).
