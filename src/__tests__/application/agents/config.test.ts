import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadModelRoutingConfig, ModelRoutingConfigSchema } from "../../../application/agents/config.js";
import { log } from "../../../core/log.js";

const tmpRoot = path.join(os.tmpdir(), `orc-config-test-${process.pid}`);
const configPath = path.join(tmpRoot, "config.json");

beforeEach(() => {
  fs.mkdirSync(tmpRoot, { recursive: true });
  if (fs.existsSync(configPath)) fs.rmSync(configPath);
});

afterEach(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

function writeConfig(json: unknown): void {
  fs.writeFileSync(configPath, JSON.stringify(json));
}

describe("loadModelRoutingConfig", () => {
  it("returns {} when the config file is absent", () => {
    expect(loadModelRoutingConfig(configPath)).toEqual({});
  });

  it("returns {} on invalid JSON", () => {
    fs.writeFileSync(configPath, "{ not json");
    expect(loadModelRoutingConfig(configPath)).toEqual({});
  });

  it("returns {} when the file is unreadable (directory path)", () => {
    fs.rmSync(configPath, { force: true });
    fs.mkdirSync(configPath);
    expect(loadModelRoutingConfig(configPath)).toEqual({});
  });

  it("returns {} when a routing block violates the schema", () => {
    writeConfig({ variants: { codegen: "not-an-object" } });
    expect(loadModelRoutingConfig(configPath)).toEqual({});
  });

  it("returns {} on a malformed variants value", () => {
    writeConfig({ variants: 42 });
    expect(loadModelRoutingConfig(configPath)).toEqual({});
  });

  it("parses an empty object", () => {
    writeConfig({});
    expect(loadModelRoutingConfig(configPath)).toEqual({});
  });

  it("extracts the variants block and ignores unknown keys", () => {
    writeConfig({
      provider: "openai",
      apiKey: "sk-test",
      model: "gpt-4o-mini",
      quotaPauseDelayMs: 5000,
      variants: { codegen: { cheap: "gpt-4o-mini", strong: "gpt-5" } },
    });
    expect(loadModelRoutingConfig(configPath)).toEqual({
      variants: { codegen: { cheap: "gpt-4o-mini", strong: "gpt-5" } },
    });
  });

  it("extracts the providers block with per-provider tokenPaidApiKey", () => {
    writeConfig({
      providers: {
        anthropic: {
          apiType: "anthropic",
          baseUrl: "https://api.anthropic.com",
          headers: { "x-custom": "v" },
          tokenPaidApiKey: "sk-ant-paid",
        },
      },
      tokenPaidApiKey: "sk-top",
    });
    expect(loadModelRoutingConfig(configPath)).toEqual({
      providers: {
        anthropic: {
          apiType: "anthropic",
          baseUrl: "https://api.anthropic.com",
          headers: { "x-custom": "v" },
          tokenPaidApiKey: "sk-ant-paid",
        },
      },
      tokenPaidApiKey: "sk-top",
    });
  });

  it("round-trips an empty-string tokenPaidApiKey (explicit absent)", () => {
    writeConfig({ tokenPaidApiKey: "" });
    expect(loadModelRoutingConfig(configPath)).toEqual({ tokenPaidApiKey: "" });
  });

  it("preserves a partial providers entry", () => {
    writeConfig({ providers: { openai: { baseUrl: "https://custom" } } });
    expect(loadModelRoutingConfig(configPath)).toEqual({
      providers: { openai: { baseUrl: "https://custom" } },
    });
  });

  it("schema accepts a valid full config (round-trip)", () => {
    const cfg = {
      variants: { codegen: { cheap: "a", strong: "b" } },
      providers: { openai: { apiType: "openai", tokenPaidApiKey: "k" } },
      tokenPaidApiKey: "top",
    };
    expect(ModelRoutingConfigSchema.parse(cfg)).toEqual(cfg);
  });

  it("M5: a malformed variants block can't disable tokenPaidApiKey (regression)", () => {
    // Pre-fix the whole-object parse in try/catch returned {} on ANY bad block,
    // silently losing the valid tokenPaidApiKey below.
    writeConfig({ variants: 42, tokenPaidApiKey: "sk-top" });
    expect(loadModelRoutingConfig(configPath)).toEqual({ tokenPaidApiKey: "sk-top" });
  });

  it("M5: a malformed providers block can't disable variants", () => {
    writeConfig({
      providers: { openai: "not-an-object" },
      variants: { codegen: { cheap: "gpt-4o-mini", strong: "gpt-5" } },
    });
    expect(loadModelRoutingConfig(configPath)).toEqual({
      variants: { codegen: { cheap: "gpt-4o-mini", strong: "gpt-5" } },
    });
  });

  it("M5: all blocks malformed -> {} (unchanged)", () => {
    writeConfig({ variants: 42, providers: 7, tokenPaidApiKey: 123 });
    expect(loadModelRoutingConfig(configPath)).toEqual({});
  });

  it("M5: each failed block produces a log line", () => {
    writeConfig({ variants: 42, tokenPaidApiKey: "sk-top" });
    const entries: string[] = [];
    const unsub = log.subscribe(e => entries.push(e.message));
    try {
      loadModelRoutingConfig(configPath);
    } finally {
      unsub();
    }
    const warnLines = entries.filter(m => m.includes("dropping malformed 'variants' block"));
    expect(warnLines.length).toBe(1);
    expect(warnLines[0]).toContain("variants");
  });
});