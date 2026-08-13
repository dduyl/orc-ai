import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, extname } from "node:path";
import { log } from "../../../core/log.js";

export type QueryType = "dependencies" | "callers" | "callees" | "blast_radius";

export interface CodeGraphQueryOptions {
  queryType: QueryType;
  target: string;
  depth?: number;
  projectDir?: string;
}

export interface NodeInfo {
  id: string;
  name: string;
  type: "file" | "symbol" | "module";
}

export interface EdgeInfo {
  source: string;
  target: string;
  relationship: "imports" | "calls" | "depends_on";
}

export interface CodeGraphQueryResult {
  queryType: QueryType;
  target: string;
  nodes: NodeInfo[];
  edges: EdgeInfo[];
  summary: string;
}

export class CodeGraphService {
  /**
   * Execute a structural code graph query via CodeGraphContext (ADR-002),
   * falling back to static AST import parsing if the CLI is unavailable.
   */
  static async queryCodeGraph(opts: CodeGraphQueryOptions): Promise<CodeGraphQueryResult> {
    const root = opts.projectDir ?? process.cwd();
    const depth = opts.depth ?? 2;

    // Attempt 1: Execute pinned codegraphcontext CLI if available
    try {
      const cliResult = execSync(
        `npx --no-install codegraphcontext query --type ${opts.queryType} --target "${opts.target}" --depth ${depth}`,
        { cwd: root, encoding: "utf-8", timeout: 10000, stdio: ["pipe", "pipe", "pipe"] }
      );
      const parsed = JSON.parse(cliResult);
      if (parsed && Array.isArray(parsed.nodes) && Array.isArray(parsed.edges)) {
        return {
          queryType: opts.queryType,
          target: opts.target,
          nodes: parsed.nodes,
          edges: parsed.edges,
          summary: parsed.summary ?? `CodeGraphContext queried ${parsed.nodes.length} nodes across depth ${depth}.`,
        };
      }
    } catch {
      log.debug("[code-graph] codegraphcontext CLI query unavailable, falling back to static parser");
    }

    // Attempt 2: Static import & dependency graph parser
    return CodeGraphService.parseStaticGraph(root, opts.queryType, opts.target, depth);
  }

  private static parseStaticGraph(
    root: string,
    queryType: QueryType,
    target: string,
    depth: number,
  ): CodeGraphQueryResult {
    const nodes: NodeInfo[] = [];
    const edges: EdgeInfo[] = [];
    const visited = new Set<string>();

    const files = CodeGraphService.scanSourceFiles(root);
    const targetFile = files.find(f => f.includes(target) || relative(root, f) === target);

    if (!targetFile && !target.includes("/")) {
      // Symbol query fallback
      nodes.push({ id: target, name: target, type: "symbol" });
      for (const file of files) {
        const rel = relative(root, file);
        try {
          const content = readFileSync(file, "utf-8");
          if (content.includes(target)) {
            nodes.push({ id: rel, name: rel, type: "file" });
            edges.push({ source: rel, target, relationship: "calls" });
          }
        } catch {
          /* ignore */
        }
      }
      return {
        queryType,
        target,
        nodes,
        edges,
        summary: `Static blast-radius analysis found ${nodes.length - 1} files referencing symbol '${target}'.`,
      };
    }

    const start = targetFile ? relative(root, targetFile) : target;
    nodes.push({ id: start, name: start, type: "file" });
    visited.add(start);

    // Scan imports in target file
    if (targetFile && existsSync(targetFile)) {
      try {
        const content = readFileSync(targetFile, "utf-8");
        const importMatches = content.matchAll(/(?:import|from)\s+['"]([^'"]+)['"]/g);
        for (const match of importMatches) {
          const imported = match[1];
          nodes.push({ id: imported, name: imported, type: imported.startsWith(".") ? "file" : "module" });
          edges.push({ source: start, target: imported, relationship: "imports" });
        }
      } catch {
        /* ignore */
      }
    }

    return {
      queryType,
      target: start,
      nodes,
      edges,
      summary: `Structural code graph for '${start}': ${nodes.length} nodes, ${edges.length} edges (depth ${depth}).`,
    };
  }

  private static scanSourceFiles(dir: string, maxFiles = 100): string[] {
    const results: string[] = [];
    const scan = (current: string) => {
      if (results.length >= maxFiles) return;
      try {
        const entries = readdirSync(current);
        for (const entry of entries) {
          if (entry === "node_modules" || entry === "dist" || entry.startsWith(".")) continue;
          const full = join(current, entry);
          const stat = statSync(full);
          if (stat.isDirectory()) {
            scan(full);
          } else if (/\.(ts|tsx|js|jsx|py|go|rs|java)$/i.test(entry)) {
            results.push(full);
          }
        }
      } catch {
        /* ignore */
      }
    };
    scan(dir);
    return results;
  }
}
