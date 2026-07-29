import { z } from "zod";

export const SchemaVersion = z.literal(1);
export type SchemaVersion = z.infer<typeof SchemaVersion>;

export const SpecEntry = z.object({
  schemaVersion: SchemaVersion,
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  affectedModules: z.array(z.string()),
  tags: z.array(z.string()),
  reasoning: z.string().optional(),
  assumptionUnverified: z.boolean().default(false),
  contextNote: z.string().optional(),
  filePath: z.string(),
});
export type SpecEntry = z.infer<typeof SpecEntry>;

export const ContractDefinition = z.object({
  schemaVersion: SchemaVersion,
  interfaces: z.array(z.object({
    name: z.string(),
    signatures: z.array(z.string()),
    description: z.string().optional(),
  })),
  dataTypes: z.array(z.object({
    name: z.string(),
    fields: z.array(z.object({ name: z.string(), type: z.string() })),
  })).optional(),
  errorBehavior: z.array(z.string()).optional(),
});
export type ContractDefinition = z.infer<typeof ContractDefinition>;

export const AdrEntry = z.object({
  schemaVersion: SchemaVersion,
  id: z.string(),
  title: z.string(),
  summary: z.string(),
  affectedModules: z.array(z.string()),
  tags: z.array(z.string()),
  reasoning: z.string(),
  contract: ContractDefinition.optional(),
  contextNote: z.string().optional(),
  filePath: z.string(),
});
export type AdrEntry = z.infer<typeof AdrEntry>;

export const CodeArtifact = z.object({
  schemaVersion: SchemaVersion,
  id: z.string(),
  files: z.array(z.object({
    path: z.string(),
    language: z.string(),
    summary: z.string().optional(),
  })),
  filePath: z.string(),
});
export type CodeArtifact = z.infer<typeof CodeArtifact>;

export const TestArtifact = z.object({
  schemaVersion: SchemaVersion,
  id: z.string(),
  testCases: z.array(z.object({
    name: z.string(),
    type: z.enum(["unit", "integration", "e2e"]),
    targetBehavior: z.string(),
  })),
  filePath: z.string(),
});
export type TestArtifact = z.infer<typeof TestArtifact>;

export const BuildResult = z.object({
  schemaVersion: SchemaVersion,
  passed: z.boolean(),
  exitCode: z.number(),
  groups: z.array(z.object({
    name: z.string(),
    exitCode: z.number(),
    stdout: z.string(),
    stderr: z.string(),
  })),
});
export type BuildResult = z.infer<typeof BuildResult>;

export const ReviewResult = z.object({
  schemaVersion: SchemaVersion,
  artifactId: z.string(),
  artifactType: z.string(),
  scores: z.record(z.string(), z.number()),
  overallScore: z.number(),
  passed: z.boolean(),
  feedback: z.string(),
  filePath: z.string(),
});
export type ReviewResult = z.infer<typeof ReviewResult>;

export const WorkflowStep = z.object({
  id: z.string(),
  agent: z.string(),
  depends_on: z.array(z.string()).default([]),
  context: z.array(z.string()).optional().default([]),
  task: z.string().optional(),
  signal: z.object({
    name: z.string(),
    description: z.string(),
    signal_on: z.string().nullable().default(null),
    signal_off: z.string().nullable().default(null),
  }).optional(),
});
export type WorkflowStep = z.infer<typeof WorkflowStep>;

export const WorkflowDefinition = z.object({
  version: SchemaVersion,
  workflow: z.object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    inputs: z.record(z.string(), z.string()).optional(),
    steps: z.array(WorkflowStep),
    completion: z.string(),
  }),
});
export type WorkflowDefinition = z.infer<typeof WorkflowDefinition>;

export function def(w: z.input<typeof WorkflowDefinition>): WorkflowDefinition {
  return w as WorkflowDefinition;
}

export const ChangeLogEntry = z.object({
  schemaVersion: SchemaVersion,
  requestId: z.string(),
  workflowId: z.string(),
  timestamp: z.string(),
  stepResults: z.array(z.object({
    stepId: z.string(),
    status: z.enum(["completed", "failed"]),
    artifactType: z.string().optional(),
  })),
  finalStatus: z.enum(["completed", "failed", "needs_human"]),
});
export type ChangeLogEntry = z.infer<typeof ChangeLogEntry>;

export const Schemas = {
  SpecEntry,
  AdrEntry,
  ContractDefinition,
  CodeArtifact,
  TestArtifact,
  BuildResult,
  ReviewResult,
  WorkflowDefinition,
  ChangeLogEntry,
} as const;
