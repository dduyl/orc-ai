import * as http from "node:http";
import * as crypto from "node:crypto";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp";
import type { Server } from "@modelcontextprotocol/sdk/server";
import { log } from "../../core/log.js";

export interface McpSession {
  transport: StreamableHTTPServerTransport;
  server: Server;
  createdAt: number;
}

export class McpHttpTransport {
  constructor(
    private sessions: Map<string, McpSession>,
    /** Invoked whenever the live session count changes (idle-gate hook). */
    private readonly onSessionChange?: (count: number) => void,
  ) {}

  getSessionId(req: http.IncomingMessage): string | null {
    const header = req.headers["mcp-session-id"] as string
      ?? req.headers["mcpsessionid"] as string;
    if (header) return header;
    const cookie = req.headers.cookie;
    if (cookie) {
      for (const c of cookie.split(";")) {
        const [k, v] = c.trim().split("=");
        if (k.toLowerCase() === "mcpsessionid") return v;
      }
    }
    return null;
  }

  async listen(
    port: number,
    createSession: (transport: StreamableHTTPServerTransport) => Promise<McpSession>,
  ): Promise<http.Server> {
    const server = http.createServer(async (req, res) => {
      res.setHeader("access-control-allow-origin", "*");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      const sessionId = this.getSessionId(req);

      try {
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (!session) {
            res.writeHead(404, { "content-type": "application/json" });
            res.end(JSON.stringify({ error: "Session not found" }));
            return;
          }
          await session.transport.handleRequest(req, res);
          return;
        }

        const transport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });

        const entry = await createSession(transport);
        await transport.handleRequest(req, res);
        const newId = transport.sessionId;
        if (newId) {
          this.sessions.set(newId, entry);
          transport.onclose = () => {
            this.sessions.delete(newId);
            this.onSessionChange?.(this.sessions.size);
          };
          this.onSessionChange?.(this.sessions.size);
        }
      } catch (err: any) {
        log.warn(`[MCP] HTTP error: ${err.message}`);
        if (!res.headersSent) {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: err.message }));
        }
      }
    });

    return new Promise<http.Server>(resolve => {
      server.listen(port, "0.0.0.0", () => {
        log.info(`[MCP] HTTP Streamable server on http://0.0.0.0:${port}`);
        resolve(server);
      });
    });
  }
}
