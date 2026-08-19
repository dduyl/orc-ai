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
    command: z.string(),
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

export const EmittedSignal = z.object({
  // Signal names join refs as `stepId.signalName`; a dot would break that
  // encoding, so it (and whitespace) are rejected up front.
  name: z.string().regex(/^[^\s.]+$/, "signal name must not contain spaces or '.', since refs encode as stepId.signalName"),
  description: z.string(),
});
export type EmittedSignal = z.infer<typeof EmittedSignal>;

/** Runner-internal seed signal. The runner fires it once at start so entry steps
 * (which listen on `__start__`) run first and can also re-run via an `any` redo edge. */
export const START_SIGNAL = "__start__";

export const WorkflowStep = z.object({
  // Step ids are referenced from other steps as `stepId.signalName`; dots and
  // whitespace would corrupt ref parsing, so they are rejected up front.
  id: z.string().regex(/^[^\s.]+$/, "step id must not contain spaces or '.', since refs encode as stepId.signalName"),
  type: z.enum(["agent", "script"]).default("agent"),
  /**
   * Required for `type: "agent"`. Forbidden for `type: "script"`.
   * Enforced by the refine below.
   */
  agent: z.string().optional(),
  /**
   * A single `run` expression for `type: "script"` steps. One of two shapes:
   * - `cmd "group.key"`  — reference a named command group in `commands.toml`
   * - `exec "literal shell"` — run a literal shell command string
   * Exactly one is required and enforced by the refine below.
   */
  run: z.string().optional(),
  /**
   * The fixed output vocabulary of this step (ADR-011). A step never names its
   * consumers; it only emits from this list.
   * - Agent steps: the agent picks one name via `return_result.signal`.
   * - Script steps: exactly 2 — `emits[0]` fires on exit 0, `emits[1]` on non-zero.
   */
  emits: z.array(EmittedSignal).min(1),
  /** AND join: run once ALL referenced `stepId.signal` signals have fired. */
  on: z.array(z.string()).optional(),
  /** OR join: run once ANY referenced `stepId.signal` signal fires. */
  any: z.array(z.string()).optional(),
  context: z.array(z.string()).optional().default([]),
  task: z.string().optional(),
}).superRefine((step, ctx) => {
  if (step.type === "script") {
    if (step.agent) {
      ctx.addIssue({ code: "custom", message: `script step '${step.id}' must not declare an agent` });
    }
    if (!step.run) {
      ctx.addIssue({ code: "custom", message: `script step '${step.id}' must declare a 'run' expression (cmd "..." or exec "...")` });
    }
    if (step.emits.length !== 2) {
      ctx.addIssue({ code: "custom", message: `script step '${step.id}' must emit exactly 2 signals (positional pass/fail)` });
    }
  } else {
    if (step.run) {
      ctx.addIssue({ code: "custom", message: `agent step '${step.id}' must not declare 'run'` });
    }
  }
  const hasOn = (step.on?.length ?? 0) > 0;
  const hasAny = (step.any?.length ?? 0) > 0;
  if (hasOn && hasAny) {
    ctx.addIssue({ code: "custom", message: `step '${step.id}' must declare exactly one of 'on' or 'any', not both` });
  }
  if (!hasOn && !hasAny) {
    ctx.addIssue({ code: "custom", message: `step '${step.id}' must declare a non-empty 'on' or 'any' list` });
  }
  const names = new Set(step.emits.map(e => e.name));
  if (names.size !== step.emits.length) {
    ctx.addIssue({ code: "custom", message: `step '${step.id}' has duplicate signal names in 'emits'` });
  }
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

export interface WorkflowValidationIssue {
  stepId?: string;
  message: string;
}

/**
 * Load-time validation of the signal graph (ADR-011). Returns every problem
 * found; an empty array means the workflow can run. An unresolvable workflow
 * must fail here rather than deadlock at runtime — callers reject the workflow
 * when this returns any issue.
 *
 * Checks:
 * - every `on`/`any` ref is `stepId.signal` (or `__start__`), the step exists,
 *   and the signal is in that producer's `emits`;
 * - every step is reachable from `__start__` (no orphaned/unfirable steps).
 */
export function validateWorkflowGraph(wf: WorkflowDefinition): WorkflowValidationIssue[] {
  const issues: WorkflowValidationIssue[] = [];
  const steps = wf.workflow.steps;
  const byId = new Map(steps.map(s => [s.id, s]));
  const emitNames = new Map<string, Set<string>>();
  for (const s of steps) emitNames.set(s.id, new Set(s.emits.map(e => e.name)));

  // Duplicate ids would silently collide in the scheduler's consumed/emitted
  // maps and merge two steps into one report entry — reject them up front.
  const seenIds = new Set<string>();
  for (const s of steps) {
    if (seenIds.has(s.id)) {
      issues.push({ stepId: s.id, message: `duplicate step id '${s.id}' (every step id must be unique)` });
    }
    seenIds.add(s.id);
  }

  for (const s of steps) {
    for (const ref of [...(s.on ?? []), ...(s.any ?? [])]) {
      if (ref === START_SIGNAL) continue;
      const dot = ref.lastIndexOf(".");
      const producerId = ref.slice(0, dot);
      const signalName = ref.slice(dot + 1);
      const producer = byId.get(producerId);
      if (!producer) {
        issues.push({ stepId: s.id, message: `signal ref '${ref}' references unknown step '${producerId}'` });
        continue;
      }
      if (!emitNames.get(producerId)!.has(signalName)) {
        issues.push({
          stepId: s.id,
          message: `signal ref '${ref}' references signal '${signalName}' which step '${producerId}' does not emit (emits: ${[...emitNames.get(producerId)!].join(", ")})`,
        });
      }
    }
  }

  const outgoing = new Map<string, string[]>();
  for (const s of steps) {
    for (const ref of [...(s.on ?? []), ...(s.any ?? [])]) {
      const producerId = ref === START_SIGNAL ? START_SIGNAL : ref.slice(0, ref.lastIndexOf("."));
      const list = outgoing.get(producerId) ?? [];
      list.push(s.id);
      outgoing.set(producerId, list);
    }
  }
  const reachable = new Set<string>();
  const queue = [START_SIGNAL];
  while (queue.length) {
    const cur = queue.shift()!;
    if (reachable.has(cur)) continue;
    reachable.add(cur);
    for (const consumerId of outgoing.get(cur) ?? []) {
      if (!reachable.has(consumerId)) queue.push(consumerId);
    }
  }
  for (const s of steps) {
    if (!reachable.has(s.id)) {
      issues.push({ stepId: s.id, message: `step '${s.id}' is unreachable: no signal path from '${START_SIGNAL}' reaches it` });
    }
  }

  return issues;
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
  finalStatus: z.enum(["completed", "failed", "needs_human", "paused"]),
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
