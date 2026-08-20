import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { loadModelRoutingConfig, ModelRoutingConfigSchema } from "../../../application/agents/config.js";

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
});