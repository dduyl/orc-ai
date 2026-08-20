import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readConfiguredProviders } from "../../../application/agents/configured-providers.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempAuth(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "orc-cp-"));
  dirs.push(dir);
  const p = join(dir, "auth.json");
  if (contents !== undefined) writeFileSync(p, contents, "utf8");
  return p;
}

describe("readConfiguredProviders", () => {
  it("includes the user config `providers` block keys", () => {
    const providers = readConfiguredProviders(
      { providers: { anthropic: {}, openai: {} } },
      tempAuth("{}"),
    );
    expect(providers.sort()).toEqual(["anthropic", "openai"]);
  });

  it("merges opencode auth.json provider keys with the config block", () => {
    const providers = readConfiguredProviders(
      { providers: { anthropic: {} } },
      tempAuth(JSON.stringify({ anthropic: "sk-test", google: "token" })),
    );
    expect(providers.sort()).toEqual(["anthropic", "google"]);
  });

  it("tolerates a missing auth.json (contributes nothing)", () => {
    const providers = readConfiguredProviders(
      { providers: { openai: {} } },
      tempAuth(),
    );
    expect(providers).toEqual(["openai"]);
  });

  it("tolerates an unreadable/invalid auth.json", () => {
    const providers = readConfiguredProviders({}, tempAuth("not json"));
    expect(providers).toEqual([]);
  });

  it("returns empty when neither source has providers", () => {
    expect(readConfiguredProviders({}, tempAuth("{}"))).toEqual([]);
  });
});