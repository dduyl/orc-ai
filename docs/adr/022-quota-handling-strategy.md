# ADR-022: Quota Handling Strategy

## Context
A quota (a usage ceiling over a long cycle — requests/day, spend/month) is
distinct from a transient rate limit: it does not clear with a short retry-
with-backoff, only after the cycle resets. Treating the two identically
means either backing off uselessly against a quota, or failing outright
when a short wait would have sufficed for a rate limit.

## Decision
On detecting quota exhaustion (as opposed to a transient rate limit),
escalate in order: downgrade to a cheaper model variant if quota remains
there (ADR-021); if none remains, checkpoint and pause (ADR-010), resuming
automatically once the quota window is known to reset; if a pause is not
viable, prioritize the critical path and defer or skip non-essential steps
(e.g. an optional deep review pass) rather than blocking entirely; always
surface the condition to the user rather than silently degrading or
hanging.

## Consequences
- Requires distinguishing quota-exhaustion errors from rate-limit errors at
  the point they're caught — treating them identically defeats the purpose
  of this ADR.
- Depends on ADR-010's checkpoint/resume mechanism being reliable; a fragile
  resume path undermines the pause-and-resume strategy here.
