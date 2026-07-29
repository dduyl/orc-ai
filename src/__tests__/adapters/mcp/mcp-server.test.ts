import { describe, it, expect } from "vitest";
import { McpServer } from "../../../adapters/mcp/server.js";
import { WorkflowRegistry } from "../../../application/planner/registry.js";
import { registerStrategy, type AgentStrategy } from "../../../application/agents/strategy.js";
import type { AdapterDef } from "../../../application/agents/adapter.js";
import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

describe("MCP Server", () => {
  it("instantiates MCP server", () => {
    const adapter: AdapterDef = { id: "test", command: "echo", label: "Test" };
    const registry = new WorkflowRegistry();
    const server = new McpServer(adapter, registry);
    expect(server).toBeDefined();
  });
});
