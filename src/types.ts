export enum ArtifactType {
  Spec = "spec",
  Adr = "adr",
  Contract = "contract",
  Code = "code",
  Test = "test",
  BuildResult = "build_result",
  ReviewResult = "review_result",
  ChangeLog = "change_log",
}

export enum StepStatus {
  Pending = "pending",
  Running = "running",
  Completed = "completed",
  Failed = "failed",
}

export enum FailureReason {
  SchemaValidation = "schema_validation",
  ReviewFailed = "review_failed",
  BuildFailed = "build_failed",
  OwnershipViolation = "ownership_violation",
  EnvironmentError = "environment_error",
  TransientError = "transient_error",
  BudgetExceeded = "budget_exceeded",
  LoopDetected = "loop_detected",
}

export interface AgentAdapterConfig {
  provider: string;
  apiKey: string;
  model?: string;
}
