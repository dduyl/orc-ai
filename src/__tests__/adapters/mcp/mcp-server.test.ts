import { describe, it, expect } from "vitest";
import { McpServer } from "../../../adapters/mcp/server.js";
import { RunHost } from "../../../application/harness/run-host.js";
import type { AdapterDef } from "../../../application/agents/adapter.js";

describe("MCP Server", () => {
  it("instantiates MCP server", () => {
    const adapter: AdapterDef = { id: "test", command: "echo", label: "Test" };
    const host = new RunHost(adapter);
    const server = new McpServer(host);
    expect(server).toBeDefined();
  });
});
