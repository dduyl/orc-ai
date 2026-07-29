import { def } from "../schemas.js";

export const featureImplementation = def({
  version: 1,
  workflow: {
    id: "feature_implementation",
    name: "Feature Implementation",
    description: "Full feature lifecycle: requirements analysis, architecture design, code generation, test generation, review, and validation. Best for new features that touch module boundaries.",
    steps: [
      { id: "spec", agent: "requirement_analyst", depends_on: [], task: "Analyze requirements" },
      { id: "review_spec", agent: "review", depends_on: ["spec"], task: "Review requirements spec", signal: { name: "spec_ok", description: "True if spec is clear and complete, false if ambiguous or missing edge cases", signal_on: null, signal_off: "spec" } },
      { id: "architecture", agent: "architecture_agent", depends_on: ["review_spec"], task: "Design architecture" },
      { id: "review_arch", agent: "review", depends_on: ["architecture"], task: "Review architecture design", signal: { name: "arch_ok", description: "True if architecture is sound and addresses all concerns, false if design issues found", signal_on: null, signal_off: "architecture" } },
      { id: "code", agent: "code_generation_backend", depends_on: ["review_arch"], task: "Generate code", context: ["spec", "architecture"] },
      { id: "test", agent: "test_generation_backend", depends_on: ["review_arch"], task: "Generate tests then run the full test suite and report results", context: ["spec", "code"] },
      { id: "review_code", agent: "review", depends_on: ["code"], task: "Review generated code", signal: { name: "code_ok", description: "True if code quality is acceptable and all tests pass, false if quality is below threshold or tests fail", signal_on: null, signal_off: "code" } },
      { id: "review_test", agent: "review", depends_on: ["test"], task: "Review generated tests", signal: { name: "test_ok", description: "True if coverage is adequate and all tests pass, false if quality is below threshold or tests fail", signal_on: null, signal_off: "test" } },
    ],
    completion: "Feature implementation complete",
  },
});
