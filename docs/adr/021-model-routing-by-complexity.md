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

## Implementation
The tier lookup lives at the `callAgentStream` boundary in `step-handler.ts`:
`resolveVariantTier` (`src/application/agents/variants.ts`) maps the step's
role + complexity signal (`readRepoState`/`classifyComplexity` in
`complexity.ts`) to a `cheap`/`strong` tier. Only two tiers exist. The
concrete model is selected by `pickVariantModel` (`src/application/agents/
models.ts`) from the agent's own advertised model list against the vendored
models.dev snapshot, restricted to providers present in the routing config.
The chosen model is applied pre-emptively at `session/new` (ACP
`set_config_option`) or via the PTY tool's model flag; a quota hit escalates
through the ADR-022 ladder (provider failover → tier downgrade → token-paid →
pause). Script steps (`type: script`) bypass model routing entirely — zero
LLM.
