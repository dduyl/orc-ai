import { rpcOk } from "./rpc.js";
import { GUIDE_TEXT, BUILTIN_PROMPTS } from "./content.js";
import type { JsonRpcResponse } from "./rpc.js";
import { setupProject } from "../../../application/harness/persistence/bootstrap.js";
import { loadAgentPrompts } from "../../../application/planner/prompt-loader.js";
import { resolveCompletion } from "../../../application/harness/signalling/StepCompletionRegistry.js";
import { log } from "../../../core/log.js";

export function handleGuideTool(id: number | string, args: any): JsonRpcResponse {
  setupProject();
  const task = (args?.task as string || "").trim();
  let text = GUIDE_TEXT;
  if (task) text += `\n\n## User Task\n\n${task}`;
  return rpcOk(id, {
    content: [{ type: "text", text }],
  });
}

export function handleListPromptsTool(id: number | string): JsonRpcResponse {
  const fromPrompts = loadAgentPrompts();
  const prompts = fromPrompts.length > 0 ? fromPrompts : BUILTIN_PROMPTS;
  return rpcOk(id, {
    content: [{ type: "text", text: JSON.stringify(prompts, null, 2) }],
  });
}

export function handleReturnResult(id: number | string, args: any): JsonRpcResponse {
  const summary = args?.summary || "(no summary)";
  const artifact = args?.artifact || "";
  const affectedFiles = args?.affectedFiles || [];
  const completionKey = args?.completionKey as string | undefined;
  log.info(`[return_result] summary="${summary}" artifact="${artifact}" files=${JSON.stringify(affectedFiles)}${completionKey ? ` key=${completionKey}` : ""}`);
  if (completionKey) {
    resolveCompletion(completionKey, { summary, artifact, affectedFiles });
  }
  return rpcOk(id, { status: "ok", message: "Result recorded." });
}
