# ORC Workflow Guide

## Mandatory flow
1. list_workflows — see what's registered
2. list_prompts — see valid agent names before creating a workflow
3. create_workflow — only when no existing workflow fits
4. run_workflow — execute by workflowId

## Rules
- Never embed a workflow definition in run_workflow
- create_workflow → run_workflow (always two separate calls)
- Agent names must match list_prompts output exactly
- Root steps have depends_on: []
- If a registered workflow matches the task but you consider it too complex or token-heavy to run, you MUST NOT bypass it. Present both options (run workflow vs. implement directly) with brief tradeoffs and let the user decide.

## Step field reference
| Field | Required | Description |
|-------|----------|-------------|
| id | yes | Unique step ID |
| type | yes | "agent" or "system" |
| agent | when type=agent | Name from list_prompts |
| function | when type=system | Currently "validate_and_test" |
| depends_on | yes | [] for root, ["stepId"] for dependents |
| task | no | What this step does |
| condition | no | Gate expression |
| context | no | Step IDs whose output to inject |
| signal | no | `{name, description, signal_on?, signal_off?}` — agent-decided quality signal. When agent returns `signal: true`, routes to `signal_on`; `false` routes to `signal_off` with cascade reset |

## Failure modes
| Error | Fix |
|-------|-----|
| Unknown agent: X | Call list_prompts, use a valid name |
| Unknown workflowId: X | Call list_workflows for valid IDs |
| Missing 'task' argument | Add a task string to run_workflow |
