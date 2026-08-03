# ADR-018: MCP Prompts as Portable Invocation Surface

## Decision
A user-triggered command (e.g. a slash command in any MCP-compatible host)
is the portable entry point into a workflow run. It is not itself the
execution engine — invoking it hands off to the Harness (ADR-014), which
runs identically regardless of which host triggered it. Specialist agents
are never defined inside a host's own subagent configuration format; they
exist only behind this system's own MCP surface, so switching host
applications never requires redefining agents.

## Consequences
- If the current MCP server exposes workflows only as callable tools rather
  than as the "prompts" primitive, the portability property may still hold
  (any MCP host can call a tool), but the discoverable slash-command UX this
  ADR intends may not yet be present. Confirm which primitive is actually
  used before relying on this distinction in documentation or support
  material.
