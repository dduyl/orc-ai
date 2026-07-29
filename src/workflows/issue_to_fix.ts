import { def } from "../schemas.js";

export const issueToFix = def({
  version: 1,
  workflow: {
    id: "issue_to_fix",
    name: "Issue to Fix",
    description: "Scoped fix workflow: requirements analysis, code fix, and review. Use for addressing specific issues or tickets without architectural changes.",
    steps: [
      { id: "spec", agent: "requirement_analyst", depends_on: [], task: "Analyze requirements" },
      { id: "review_spec", agent: "review", depends_on: ["spec"], task: "Review requirements spec", signal: { name: "spec_ok", description: "True if requirements are clear and complete, false if ambiguous or missing details", signal_on: null, signal_off: "spec" } },
      { id: "code", agent: "code_generation_backend", depends_on: ["review_spec"], task: "Generate code" },
      { id: "review_code", agent: "review", depends_on: ["code"], task: "Review code changes", signal: { name: "fix_ok", description: "True if the fix correctly resolves the issue and all tests pass, false if problems remain or tests fail", signal_on: null, signal_off: "code" } },
    ],
    completion: "Issue resolved",
  },
});
