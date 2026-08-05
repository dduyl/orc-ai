import type { CallToolResult } from "@modelcontextprotocol/sdk/types";
import { GUIDE_TEXT, BUILTIN_PROMPTS } from "./content.js";
import { setupProject } from "../../../application/harness/persistence/bootstrap.js";
import { loadAgentPrompts } from "../../../application/planner/prompt-loader.js";
import { resolveCompletion } from "../../../application/harness/signalling/StepCompletionRegistry.js";
import { log } from "../../../core/log.js";

export function handleGuideTool(args: any): CallToolResult {
  setupProject();
  const task = (args?.task as string || "").trim();
  let text = GUIDE_TEXT;
  if (task) text += `\n\n## User Task\n\n${task}`;
  return {
    content: [{ type: "text", text }],
  };
}

export function handleListPromptsTool(): CallToolResult {
  const fromPrompts = loadAgentPrompts();
  const prompts = fromPrompts.length > 0 ? fromPrompts : BUILTIN_PROMPTS;
  return {
    content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }],
  };
}

export function handleReturnResult(args: any): CallToolResult {
  const summary = args?.summary || "(no summary)";
  const artifact = args?.artifact || "";
  const affectedFiles = args?.affectedFiles || [];
  const signal = args?.signal;
  const completionKey = args?.completionKey as string | undefined;
  log.info(`[return_result] summary="${summary}" artifact="${artifact}" files=${JSON.stringify(affectedFiles)}${completionKey ? ` key=${completionKey}` : ""}${signal !== undefined ? ` signal=${signal}` : ""}`);
  if (completionKey) {
    resolveCompletion(completionKey, { summary, artifact, affectedFiles, signal });
  }
  return {
    content: [{ type: "text", text: "Result recorded." }],
  };
}