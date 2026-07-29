import { def } from "../schemas.js";

export const bugfix = def({
  version: 1,
  workflow: {
    id: "bugfix",
    name: "Bugfix",
    description: "Lightweight fix workflow: requirements analysis, code fix, and review. Use for targeted bug fixes without architectural changes.",
    steps: [
      { id: "spec", agent: "requirement_analyst", depends_on: [], task: "Analyze requirements" },
      { id: "review_spec", agent: "review", depends_on: ["spec"], task: "Review requirements spec", signal: { name: "spec_ok", description: "True if bug description is clear and reproduction steps are accurate, false if unclear", signal_on: null, signal_off: "spec" } },
      { id: "code", agent: "code_generation_backend", depends_on: ["review_spec"], task: "Generate code" },
      { id: "review_code", agent: "review", depends_on: ["code"], task: "Review code changes", signal: { name: "fix_ok", description: "True if the fix correctly addresses the bug and doesn't introduce regressions and all tests pass, false if still broken or tests fail", signal_on: null, signal_off: "code" } },
    ],
    completion: "Bug fixed",
  },
});
