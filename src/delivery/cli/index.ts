#!/usr/bin/env node
import { Command } from "commander";
import { startMcp } from "./commands/mcp.js";
import { registerDaemonCommands } from "./commands/daemon.js";

const program = new Command();

program
  .name("orc")
  .description("ORC — AI Code Orchestrator")
  .version("0.1.0");

program
  .command("mcp")
  .description("Start the MCP HTTP server (headless, no GUI)")
  .action(() => startMcp());

registerDaemonCommands(program);

program.parseAsync().catch(err => { console.error(err.message); process.exit(1); });
