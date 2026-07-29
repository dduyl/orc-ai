#!/usr/bin/env node
import { Command } from "commander";
import { BUILTIN_ADAPTERS, getAdapter } from "../../application/agents/adapter.js";
import { startMcp } from "./commands/mcp.js";
import { startGui } from "./commands/start-gui.js";

const program = new Command();

program
  .name("orc")
  .description("ORC — AI Code Orchestrator")
  .version("0.1.0");

program
  .command("start")
  .description("Spawn an agent interactively")
  .argument("<adapter-id>", `Agent to spawn (${BUILTIN_ADAPTERS.map(a => a.id).join(", ")})`)
  .action(async (adapterId: string) => {
    const adapter = getAdapter(adapterId);
    if (!adapter) {
      console.error(`Unknown adapter "${adapterId}". Available: ${BUILTIN_ADAPTERS.map(a => a.id).join(", ")}`);
      process.exit(1);
    }
    await startGui(adapter);
  });

program
  .command("mcp")
  .description("Start the MCP HTTP server (standalone)")
  .action(() => startMcp());

program.parseAsync().catch(err => { console.error(err.message); process.exit(1); });
