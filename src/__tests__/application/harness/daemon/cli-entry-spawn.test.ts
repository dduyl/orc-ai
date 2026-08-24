import { describe, it, expect } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";

/**
 * Regression: models.ts imported a .json snapshot without
 * `with { type: "json" }`, so strict Node ESM killed every spawned
 * `orc daemon start` child at module-link time — invisible to this suite,
 * which constructs DaemonServer in-process and never exercises the real
 * CLI entry as a spawned child. This file closes both gaps.
 */

const repoRoot = process.cwd();
const distEntry = join(repoRoot, "dist", "delivery", "cli", "index.js");

/** Spawn the built CLI exactly like the GUI's dev path does. */
function spawnDaemon(): ChildProcess {
  return spawn(process.execPath, [join("dist", "delivery", "cli", "index.js"), "daemon", "start", "--no-mcp"], {
    cwd: process.cwd(),
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("orc daemon start (real child process)", () => {
  it.skipIf(!existsSync(distEntry))(
    "binds its control pipe within 5s of spawn",
    async () => {
      const child = spawnDaemon();
      let out = "";
      child.stdout?.on("data", (d) => { out += d.toString(); });
      child.stderr?.on("data", (d) => { out += d.toString(); });

      const bound = await new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5000);
        const check = setInterval(() => {
          if (out.includes("daemon listening")) {
            clearTimeout(timer);
            clearInterval(check);
            resolve(true);
          }
        }, 50);
        child.once("exit", () => {
          clearTimeout(timer);
          clearInterval(check);
          resolve(false);
        });
      });

      child.kill();
      if (!bound) {
        throw new Error(
          `daemon child did not bind its control pipe within 5s.\n--- child output ---\n${out}`,
        );
      }
      expect(out).toContain("control pipe on");
    },
    15_000,
  );
});

describe("json import attributes (strict node ESM)", () => {
  it("every relative .json import under src/application|adapters|core carries 'with { type: \"json\" }'", async () => {
    const { readdirSync, readFileSync } = await import("node:fs");
    const offenders: string[] = [];
    const roots = ["src/application", "src/adapters", "src/core"].map((r) => join(repoRoot, r));

    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "node_modules" || entry.name.startsWith("generated-")) continue;
          walk(full);
        } else if (/\.ts$/.test(entry.name)) {
          const text = readFileSync(full, "utf8");
          // A relative .json import must declare the attribute after the
          // specifier: `from "./x.json" with { type: "json" }`. Bare
          // specifiers (packages) are out of scope.
          const re = /from\s+["'](\.[^"']*\.json)["']/g;
          for (const m of text.matchAll(re)) {
            const after = text.slice(m.index! + m[0].length, m.index! + m[0].length + 60);
            if (!/^\s*with\s*\{\s*type:\s*["']json["']/.test(after)) {
              offenders.push(`${relative(repoRoot, full)}: '${m[1]}'`);
            }
          }
        }
      }
    };
    roots.forEach(walk);

    expect(offenders).toEqual([]);
  });
});
