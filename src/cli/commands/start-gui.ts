import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdapterDef } from "../../agents/adapter.js";

const _require = createRequire(import.meta.url);
const __dirname = dirname(fileURLToPath(import.meta.url));

export async function startGui(adapter: AdapterDef): Promise<void> {
  const electronPath: string = _require("electron");
  const mainScript = join(__dirname, "..", "..", "..", "dist", "gui", "main.js");

  const child = spawn(electronPath, [mainScript, "--adapter", adapter.id], {
    stdio: "inherit",
    env: { ...process.env },
  });

  await new Promise<void>((resolve, reject) => {
    child.on("exit", (code) => {
      if (code && code !== 0) {
        console.error(`Electron exited with code ${code}`);
      }
      resolve();
    });
    child.on("error", reject);
  });
}
