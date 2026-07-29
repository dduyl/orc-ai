import { describe, it, expect } from "vitest";
import {
  SpecEntry, AdrEntry, ContractDefinition,
  CodeArtifact, TestArtifact, BuildResult,
  ReviewResult, WorkflowDefinition, ChangeLogEntry,
} from "../schemas.js";

const validSpec = {
  schemaVersion: 1,
  id: "spec-001",
  title: "Add user login",
  summary: "A login form with email and password",
  affectedModules: ["auth"],
  tags: ["feature"],
  filePath: ".agents/requirements/spec-001.md",
};

const validAdr = {
  schemaVersion: 1,
  id: "adr-001",
  title: "Use JWT for auth",
  summary: "Adopt JWT tokens for stateless auth",
  affectedModules: ["auth"],
  tags: ["security"],
  reasoning: "Stateless auth simplifies horizontal scaling",
  filePath: ".agents/architecture/adr-001.md",
};

const validContract = {
  schemaVersion: 1,
  interfaces: [
    {
      name: "AuthService",
      signatures: ["login(email: string, password: string): Promise<TokenResponse>"],
    },
  ],
};

const validCode = {
  schemaVersion: 1,
  id: "code-001",
  files: [{ path: "src/auth/login.ts", language: "typescript" }],
  filePath: "src/auth/login.ts",
};

const validTest = {
  schemaVersion: 1,
  id: "test-001",
  testCases: [
    { name: "login succeeds", type: "unit" as const, targetBehavior: "returns token on valid credentials" },
  ],
  filePath: ".agents/tests/test-001.md",
};

const validBuild = {
  schemaVersion: 1,
  passed: true,
  exitCode: 0,
  groups: [
    { name: "validate", exitCode: 0, stdout: "", stderr: "" },
  ],
};

const validReview = {
  schemaVersion: 1,
  artifactId: "code-001",
  artifactType: "code",
  scores: { correctness: 0.9, style: 0.8 },
  overallScore: 0.85,
  passed: true,
  feedback: "Looks good",
  filePath: ".agents/review/code-001.md",
};

const validWorkflow = {
  version: 1,
  workflow: {
    id: "test_workflow",
    name: "Test Workflow",
    inputs: { description: "string" },
    steps: [
      { id: "step1", agent: "requirement_analyst", task: "Analyze: {{ description }}", depends_on: [] },
    ],
    completion: "step1.passed",
  },
};

const validChangelog = {
  schemaVersion: 1,
  requestId: "req-001",
  workflowId: "test_workflow",
  timestamp: new Date().toISOString(),
  stepResults: [{ stepId: "step1", status: "completed" as const }],
  finalStatus: "completed" as const,
};

describe("SpecEntry", () => {
  it("accepts valid spec", () => {
    expect(() => SpecEntry.parse(validSpec)).not.toThrow();
  });
  it("rejects missing required fields", () => {
    expect(() => SpecEntry.parse({})).toThrow();
  });
  it("rejects wrong schemaVersion", () => {
    expect(() => SpecEntry.parse({ ...validSpec, schemaVersion: 2 })).toThrow();
  });
});

describe("AdrEntry", () => {
  it("accepts valid adr", () => {
    expect(() => AdrEntry.parse(validAdr)).not.toThrow();
  });
  it("rejects missing reasoning", () => {
    expect(() => AdrEntry.parse({ ...validAdr, reasoning: undefined })).toThrow();
  });
});

describe("ContractDefinition", () => {
  it("accepts valid contract", () => {
    expect(() => ContractDefinition.parse(validContract)).not.toThrow();
  });
  it("requires interfaces array", () => {
    expect(() => ContractDefinition.parse({ schemaVersion: 1 })).toThrow();
  });
});

describe("CodeArtifact", () => {
  it("accepts valid code artifact", () => {
    expect(() => CodeArtifact.parse(validCode)).not.toThrow();
  });
});

describe("TestArtifact", () => {
  it("accepts valid test artifact", () => {
    expect(() => TestArtifact.parse(validTest)).not.toThrow();
  });
  it("rejects invalid test type", () => {
    expect(() => TestArtifact.parse({ ...validTest, testCases: [{ name: "x", type: "invalid", targetBehavior: "x" }] })).toThrow();
  });
});

describe("BuildResult", () => {
  it("accepts valid build result", () => {
    expect(() => BuildResult.parse(validBuild)).not.toThrow();
  });
});

describe("ReviewResult", () => {
  it("accepts valid review", () => {
    expect(() => ReviewResult.parse(validReview)).not.toThrow();
  });
});

describe("WorkflowDefinition", () => {
  it("accepts valid workflow", () => {
    expect(() => WorkflowDefinition.parse(validWorkflow)).not.toThrow();
  });
  it("rejects missing steps", () => {
    expect(() => WorkflowDefinition.parse({ version: 1, workflow: { id: "x", name: "x", completion: "x" } })).toThrow();
  });
});

describe("ChangeLogEntry", () => {
  it("accepts valid changelog", () => {
    expect(() => ChangeLogEntry.parse(validChangelog)).not.toThrow();
  });
  it("rejects invalid finalStatus", () => {
    expect(() => ChangeLogEntry.parse({ ...validChangelog, finalStatus: "unknown" })).toThrow();
  });
});
